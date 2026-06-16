import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import {
  normalizeSelectionTranslationModel,
  normalizeSelectionTranslationThinkingMode,
  requestDeepSeekSelectionTranslation,
  type SelectionTranslationErrorCode,
  type SelectionTranslationThinkingMode,
} from "./provider";

const MAX_SELECTION_LENGTH = 5000;
const ROOT_CLASS = "immersivetranslate-selection-translation";
const STYLE_ID = "immersivetranslate-selection-translation-style";
const ANNOTATION_BLOCK_START = "[Immersive Translate Selection Translation]";
const ANNOTATION_BLOCK_END = "[/Immersive Translate Selection Translation]";
const ITEM_PANE_SECTION_ID = "immersivetranslate-selection-translation";
const MAX_AUTO_ANNOTATION_IDS_PER_NOTIFY = 1;
const MAX_AUTO_ANNOTATION_QUEUE_SIZE = 10;
const MAX_AUTO_ANNOTATION_REQUESTS_PER_WINDOW = 5;
const AUTO_ANNOTATION_REQUEST_DELAY_MS = 500;
const AUTO_ANNOTATION_REQUEST_WINDOW_MS = 60_000;
const RECENT_READER_SELECTION_WINDOW_MS = 15_000;
const MAX_RECENT_READER_SELECTIONS = 10;

type ReaderSelectionEvent = {
  reader?: {
    type?: string;
    itemID?: number;
    annotationItemIDs?: number[];
    focus?: () => void;
    setAnnotations?: (items: Zotero.Item[]) => void;
  };
  doc: Document;
  params?: {
    annotation?: {
      id?: number | string;
      itemID?: number;
      key?: string;
      libraryID?: number;
      readOnly?: boolean;
      text?: string;
    };
    annotationID?: number | string;
    currentID?: number | string;
    id?: number | string;
    ids?: Array<number | string>;
  };
  append: (...nodes: Array<Node | string>) => void;
};

type ReaderContextMenuItem = {
  label: string;
  disabled?: boolean;
  onCommand: () => void;
};

type AnnotationContext = {
  key: string;
  libraryID: number;
  itemID?: number;
  readOnly: boolean;
  reader?: ReaderSelectionEvent["reader"];
};

type TranslationStatus =
  | "idle"
  | "loading"
  | "success"
  | "error"
  | "missing-key"
  | "length"
  | "empty";

type SelectionState = {
  id: number;
  requestID: number;
  itemID?: number;
  sourceText: string;
  translatedText: string;
  targetLanguage: string;
  model: string;
  thinkingMode: SelectionTranslationThinkingMode;
  status: TranslationStatus;
  message: string;
  annotation?: AnnotationContext;
};

type ItemPaneSectionRenderContext = {
  body?: HTMLElement;
  item?: Zotero.Item;
  refresh?: () => void;
};

type ItemPaneInitContext = ItemPaneSectionRenderContext | (() => void);

type PopupSession = SelectionState & {
  doc: Document;
  root: HTMLElement;
  body: HTMLElement;
  unloadWindow?: Window;
  unloadListener?: () => void;
};

type AutoAnnotationJob = {
  id: number;
  annotation: AnnotationContext;
  itemID: number;
  sourceText: string;
};

type ReaderEventGuard = {
  isAlive: () => boolean;
  dispose: () => void;
};

type RecentReaderSelection = {
  itemID?: number;
  sourceText: string;
  timestamp: number;
};

type ReaderEventRegistry = {
  registerEventListener?: (
    eventName: string,
    handler: (event: ReaderSelectionEvent) => void,
    pluginID: string,
  ) => void;
  unregisterEventListener?: (
    eventName: string,
    handler: (event: ReaderSelectionEvent) => void,
  ) => void;
};

let registered = false;
let itemPaneRegistered = false;
let annotationContextMenuRegistered = false;
let annotationHeaderRegistered = false;
let nextSessionID = 0;
let nextRequestID = 0;
let nextAutoAnnotationJobID = 0;
let activeSession: PopupSession | undefined;
let latestState: SelectionState | undefined;
let autoAnnotationProcessing = false;
const autoAnnotationQueue: AutoAnnotationJob[] = [];
const autoAnnotationRequestTimes: number[] = [];
const recentReaderSelections: RecentReaderSelection[] = [];
const pendingAutoAnnotationItemIDs = new Set<number>();
const itemPaneBodies = new Map<HTMLElement, Zotero.Item | undefined>();
const itemPaneRefreshCallbacks = new Set<() => void>();
let activeSpeech:
  | {
      ownerID: number;
      synth: SpeechSynthesis;
    }
  | undefined;

export function registerSelectionTranslation() {
  if (registered) {
    return;
  }
  if (!Zotero.Reader?.registerEventListener) {
    return;
  }
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    handleRenderTextSelectionPopup,
    addon.data.config.addonID,
  );
  try {
    (Zotero.Reader as unknown as ReaderEventRegistry).registerEventListener?.(
      "createAnnotationContextMenu",
      handleCreateAnnotationContextMenu,
      addon.data.config.addonID,
    );
    annotationContextMenuRegistered = true;
  } catch (_error) {
    annotationContextMenuRegistered = false;
  }
  try {
    (Zotero.Reader as unknown as ReaderEventRegistry).registerEventListener?.(
      "renderSidebarAnnotationHeader",
      handleRenderSidebarAnnotationHeader,
      addon.data.config.addonID,
    );
    annotationHeaderRegistered = true;
  } catch (_error) {
    annotationHeaderRegistered = false;
  }
  registerItemPaneSection();
  registered = true;
}

export function unregisterSelectionTranslation() {
  if (!registered) {
    return;
  }
  Zotero.Reader?.unregisterEventListener?.(
    "renderTextSelectionPopup",
    handleRenderTextSelectionPopup,
  );
  if (annotationContextMenuRegistered) {
    (Zotero.Reader as unknown as ReaderEventRegistry).unregisterEventListener?.(
      "createAnnotationContextMenu",
      handleCreateAnnotationContextMenu,
    );
    annotationContextMenuRegistered = false;
  }
  if (annotationHeaderRegistered) {
    (Zotero.Reader as unknown as ReaderEventRegistry).unregisterEventListener?.(
      "renderSidebarAnnotationHeader",
      handleRenderSidebarAnnotationHeader,
    );
    annotationHeaderRegistered = false;
  }
  unregisterItemPaneSection();
  registered = false;
  cleanupActiveSession();
  latestState = undefined;
  autoAnnotationQueue.length = 0;
  autoAnnotationRequestTimes.length = 0;
  recentReaderSelections.length = 0;
  pendingAutoAnnotationItemIDs.clear();
  autoAnnotationProcessing = false;
  itemPaneBodies.clear();
  itemPaneRefreshCallbacks.clear();
}

export function handleSelectionTranslationItemAdded(
  ids: Array<string | number>,
  extraData: { [key: string]: any } = {},
) {
  if (
    !registered ||
    getPref("selectionTranslationAutoTranslateNewAnnotations") !== true
  ) {
    return;
  }
  if (
    ids.length === 0 ||
    ids.length > MAX_AUTO_ANNOTATION_IDS_PER_NOTIFY ||
    ids.length !== 1 ||
    hasSyncImportOrBulkSignal(extraData)
  ) {
    return;
  }

  for (const id of ids) {
    const item = Zotero.Items.get(id);
    if (!isAutoTranslatableAnnotationItem(item)) {
      continue;
    }
    const sourceText = getAnnotationItemSourceText(item);
    if (
      !sourceText ||
      sourceText.length > MAX_SELECTION_LENGTH ||
      !matchesRecentReaderSelection(item, sourceText) ||
      hasExistingAnnotationTranslationBlock(item)
    ) {
      continue;
    }
    enqueueAutoAnnotationTranslation(item, sourceText);
  }
}

function handleCreateAnnotationContextMenu(event: ReaderSelectionEvent) {
  if (event.reader?.type !== "pdf") {
    return;
  }

  const annotation =
    getAnnotationContextFromIDs(event) ?? getAnnotationContext(event);
  const hasAnnotationCandidate = Boolean(
    annotation || getAnnotationPayloadIDs(event).length > 0,
  );
  if (!hasAnnotationCandidate) {
    return;
  }

  let started = false;
  const appendContextMenuItem = event.append as unknown as (
    item: ReaderContextMenuItem,
  ) => void;
  appendContextMenuItem({
    label: getString("selection-translation-sidebar-annotation-action"),
    disabled: annotation?.readOnly,
    onCommand: () => {
      const commandAnnotation =
        getAnnotationContextFromIDs(event) ?? getAnnotationContext(event);
      if (commandAnnotation?.readOnly) {
        return;
      }
      if (started) {
        return;
      }
      started = true;
      void translateAnnotationFromContextMenu(event, commandAnnotation);
    },
  });
}

function handleRenderSidebarAnnotationHeader(event: ReaderSelectionEvent) {
  if (event.reader?.type !== "pdf") {
    return;
  }

  const annotation =
    getAnnotationContextFromIDs(event) ?? getAnnotationContext(event);
  const hasAnnotationCandidate = Boolean(
    annotation || getAnnotationPayloadIDs(event).length > 0,
  );
  if (!hasAnnotationCandidate || typeof event.append !== "function") {
    return;
  }

  const doc = event.doc;
  if (!doc?.createElement) {
    return;
  }

  const button = doc.createElement("button");
  button.type = "button";
  button.className = `${ROOT_CLASS}__annotation-header-button`;
  button.textContent = getString(
    "selection-translation-annotation-header-action",
  );
  button.title = getString("selection-translation-annotation-header-action");
  button.setAttribute(
    "aria-label",
    getString("selection-translation-annotation-header-action"),
  );
  if (annotation?.readOnly) {
    button.disabled = true;
  }

  button.addEventListener("click", (event_) => {
    event_.preventDefault();
    event_.stopPropagation();
    const commandAnnotation =
      getAnnotationContextFromIDs(event) ?? getAnnotationContext(event);
    if (!commandAnnotation || commandAnnotation.readOnly) {
      return;
    }
    button.disabled = true;
    void translateAnnotationFromHeader(event, commandAnnotation, button);
  });

  try {
    event.append(button);
  } catch (_error) {
    // Annotation header hooks are runtime-version-sensitive. Keep the context
    // menu as the supported fallback if the header surface rejects our button.
  }
}

function handleRenderTextSelectionPopup(event: ReaderSelectionEvent) {
  if (event.reader?.type !== "pdf") {
    return;
  }

  cleanupActiveSession();
  const selectedText = event.params?.annotation?.text?.trim() || "";
  if (!selectedText) {
    return;
  }
  recordRecentReaderSelection(event, selectedText);

  injectStyles(event.doc);
  const entry = createPopupEntry(event, selectedText);
  event.append(entry);
  if (getPref("selectionTranslationAutoTranslateText") === true) {
    startSelectionTranslation(event, selectedText);
  }
}

function createPopupEntry(
  event: ReaderSelectionEvent,
  selectedText: string,
): HTMLElement {
  const entry = event.doc.createElement("span");
  entry.className = `${ROOT_CLASS}__popup-entry`;

  const button = event.doc.createElement("button");
  button.type = "button";
  button.className = `${ROOT_CLASS}__translate-button`;
  button.textContent = getString("selection-translation-action");
  button.addEventListener("click", (event_) => {
    event_.preventDefault();
    event_.stopPropagation();
    startSelectionTranslation(event, selectedText);
  });

  entry.append(button);
  return entry;
}

function startSelectionTranslation(
  event: ReaderSelectionEvent,
  sourceText: string,
) {
  cleanupActiveSession();
  injectStyles(event.doc);

  const session = createSession(event, sourceText);
  activeSession = session;
  latestState = toSelectionState(session);
  bindReaderUnload(session);
  refreshItemPaneSections();

  if (sourceText.length > MAX_SELECTION_LENGTH) {
    updateSession(session, {
      status: "length",
      message: getString("selection-translation-error-length"),
    });
    return;
  }

  const apiKey =
    `${getPref("selectionTranslationDeepSeekApiKey") || ""}`.trim();
  if (!apiKey) {
    updateSession(session, {
      status: "missing-key",
      message: getString("selection-translation-missing-key"),
    });
    return;
  }

  updateSession(session, {
    status: "loading",
    message: getString("selection-translation-loading"),
  });
  revealItemPaneSection(toSelectionState(session));
  void translateForSession(session, apiKey);
}

async function translateAnnotationFromContextMenu(
  event: ReaderSelectionEvent,
  annotation?: AnnotationContext,
) {
  const sourceText = getAnnotationSourceText(event, annotation);
  const state = createSelectionState(event, sourceText, annotation);
  const guard = createReaderEventGuard(event);
  try {
    await translateAnnotationState(state, sourceText, {
      autoWrite: "if-enabled",
      canAutoWrite: () =>
        guard.isAlive() &&
        isCurrentReaderEventRequest(event, state, sourceText),
      isCurrent: () =>
        guard.isAlive() &&
        isCurrentReaderEventRequest(event, state, sourceText),
      reveal: false,
    });
  } finally {
    guard.dispose();
  }
}

async function translateAnnotationFromHeader(
  event: ReaderSelectionEvent,
  annotation: AnnotationContext,
  button: HTMLButtonElement,
) {
  const defaultLabel = getString(
    "selection-translation-annotation-header-action",
  );
  const sourceText = getAnnotationSourceText(event, annotation);
  const state = createSelectionState(event, sourceText, annotation);
  const guard = createReaderEventGuard(event);
  try {
    await translateAnnotationState(state, sourceText, {
      autoWrite: "if-enabled",
      canAutoWrite: () =>
        button.isConnected &&
        guard.isAlive() &&
        isCurrentReaderEventRequest(event, state, sourceText),
      isCurrent: () =>
        button.isConnected &&
        guard.isAlive() &&
        isCurrentReaderEventRequest(event, state, sourceText),
      reveal: false,
      setStatus: (message, disabled) => {
        button.disabled = disabled === true;
        button.title = message || defaultLabel;
        button.setAttribute("aria-label", message || defaultLabel);
      },
    });
  } finally {
    guard.dispose();
    if (button.isConnected) {
      button.disabled = false;
    }
  }
}

async function translateAnnotationState(
  state: SelectionState,
  sourceText: string,
  options: {
    autoWrite?: "if-enabled" | "always";
    autoWriteSuccessKey?: string;
    canAutoWrite?: () => boolean;
    reveal?: boolean;
    setStatus?: (message: string, disabled?: boolean) => void;
    isCurrent: () => boolean;
  },
) {
  const requestedSourceText = sourceText;
  const requestID = ++nextRequestID;
  state.requestID = requestID;
  latestState = state;
  refreshItemPaneSections();

  if (!requestedSourceText) {
    updateLatestState(state, {
      status: "empty",
      message: getString("selection-translation-error-empty"),
    });
    options.setStatus?.(getString("selection-translation-error-empty"));
    return;
  }
  if (requestedSourceText.length > MAX_SELECTION_LENGTH) {
    updateLatestState(state, {
      status: "length",
      message: getString("selection-translation-error-length"),
    });
    options.setStatus?.(getString("selection-translation-error-length"));
    return;
  }

  const apiKey =
    `${getPref("selectionTranslationDeepSeekApiKey") || ""}`.trim();
  if (!apiKey) {
    updateLatestState(state, {
      status: "missing-key",
      message: getString("selection-translation-missing-key"),
    });
    options.setStatus?.(getString("selection-translation-missing-key"));
    return;
  }

  updateLatestState(state, {
    status: "loading",
    message: getString("selection-translation-loading"),
  });
  if (options.reveal === false) {
    refreshItemPaneSections();
  } else {
    revealItemPaneSection(state);
  }
  options.setStatus?.(getString("selection-translation-loading"), true);
  const result = await requestDeepSeekSelectionTranslation({
    apiKey,
    text: requestedSourceText,
    targetLanguage: state.targetLanguage,
    model: state.model,
    thinkingMode: state.thinkingMode,
  }).catch(() => {
    return { ok: false as const, code: "server" as const };
  });
  if (
    !options.isCurrent() ||
    latestState?.requestID !== requestID ||
    state.sourceText !== requestedSourceText
  ) {
    return;
  }
  options.setStatus?.(state.message, false);

  if (!result.ok) {
    const message = getProviderErrorMessage(result.code);
    updateLatestState(state, {
      status: result.code === "empty" ? "empty" : "error",
      message,
    });
    options.setStatus?.(message);
    return;
  }

  updateLatestState(state, {
    status: "success",
    translatedText: result.translation,
    message: getString("selection-translation-success"),
  });
  options.setStatus?.(getString("selection-translation-success"));
  if (options.autoWrite) {
    await maybeAutoWriteAnnotationComment(state, {
      canMutate: () =>
        options.isCurrent() && (options.canAutoWrite?.() ?? true),
      requirePref: options.autoWrite === "if-enabled",
      successKey:
        options.autoWriteSuccessKey ??
        "selection-translation-annotation-auto-write-success",
    });
  }
}

function getAnnotationSourceText(
  event: ReaderSelectionEvent,
  annotationContext?: AnnotationContext,
): string {
  const annotationText = event.params?.annotation?.text?.trim();
  if (annotationText) {
    return annotationText;
  }

  const annotation = annotationContext ?? getAnnotationContext(event);
  if (!annotation) {
    return "";
  }
  const item = getCurrentAnnotationItem(annotation);
  return typeof item?.annotationText === "string"
    ? item.annotationText.trim()
    : "";
}

function createSelectionState(
  event: ReaderSelectionEvent,
  sourceText: string,
  annotationContext?: AnnotationContext,
): SelectionState {
  return {
    id: ++nextSessionID,
    requestID: 0,
    itemID: event.reader?.itemID,
    sourceText,
    translatedText: "",
    targetLanguage: `${getPref("targetLanguage") || "zh-CN"}`,
    model: normalizeSelectionTranslationModel(
      getPref("selectionTranslationModel"),
    ),
    thinkingMode: normalizeSelectionTranslationThinkingMode(
      getPref("selectionTranslationThinkingMode"),
    ),
    status: "idle",
    message: "",
    annotation: annotationContext ?? getAnnotationContext(event),
  };
}

function createSession(
  event: ReaderSelectionEvent,
  sourceText: string,
): PopupSession {
  const doc = event.doc;
  const root = doc.createElement("section");
  root.className = `${ROOT_CLASS}__panel`;
  root.setAttribute("aria-live", "polite");

  const body = doc.createElement("div");
  root.append(body);

  return {
    id: ++nextSessionID,
    requestID: 0,
    itemID: event.reader?.itemID,
    doc,
    sourceText,
    translatedText: "",
    targetLanguage: `${getPref("targetLanguage") || "zh-CN"}`,
    model: normalizeSelectionTranslationModel(
      getPref("selectionTranslationModel"),
    ),
    thinkingMode: normalizeSelectionTranslationThinkingMode(
      getPref("selectionTranslationThinkingMode"),
    ),
    status: "idle",
    message: "",
    annotation: getAnnotationContext(event),
    root,
    body,
  };
}

function getAnnotationContext(
  event: ReaderSelectionEvent,
): AnnotationContext | undefined {
  const annotation = event.params?.annotation;
  if (
    !annotation ||
    typeof annotation.libraryID !== "number" ||
    !annotation.key
  ) {
    return undefined;
  }

  return {
    key: annotation.key,
    libraryID: annotation.libraryID,
    itemID: getAnnotationItemID(annotation.libraryID, annotation.key),
    readOnly: annotation.readOnly === true,
    reader: event.reader,
  };
}

function getAnnotationContextFromIDs(
  event: ReaderSelectionEvent,
): AnnotationContext | undefined {
  const item = getAnnotationPayloadIDs(event)
    .map((id) => getAnnotationItemFromPayloadID(event, id))
    .find((candidate) => candidate?.isAnnotation());
  if (!item?.isAnnotation()) {
    return undefined;
  }
  return {
    key: item.key,
    libraryID: item.libraryID,
    itemID: item.id,
    readOnly: !item.isEditable("edit"),
    reader: event.reader,
  };
}

function getAnnotationPayloadIDs(
  event: ReaderSelectionEvent,
): Array<number | string> {
  const ids = event.params?.ids ?? [];
  const currentID = event.params?.currentID;
  const annotation = event.params?.annotation;
  return [
    currentID,
    event.params?.id,
    event.params?.annotationID,
    annotation?.itemID,
    annotation?.id,
    ...ids,
  ].filter(
    (id): id is number | string =>
      typeof id === "number" || typeof id === "string",
  );
}

function getAnnotationItemFromPayloadID(
  event: ReaderSelectionEvent,
  id: number | string,
): Zotero.Item | undefined {
  if (typeof id === "number") {
    return Zotero.Items.get(id);
  }

  const numericID = Number(id);
  if (Number.isInteger(numericID)) {
    const item = Zotero.Items.get(numericID);
    if (item?.isAnnotation()) {
      return item;
    }
  }

  const annotationItemIDs = event.reader?.annotationItemIDs ?? [];
  return annotationItemIDs
    .map((itemID) => Zotero.Items.get(itemID))
    .find((item) => item?.isAnnotation() && item.key === id);
}

function getAnnotationItemID(
  libraryID: number,
  key: string,
): number | undefined {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
  return item ? item.id : undefined;
}

function hasSyncImportOrBulkSignal(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 2) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nestedValue]) => {
      const normalizedKey = key.toLowerCase();
      const hasGuardedKey = ["sync", "import", "bulk", "restore"].some(
        (guardedKey) => normalizedKey.includes(guardedKey),
      );
      if (
        hasGuardedKey &&
        nestedValue !== false &&
        nestedValue !== undefined &&
        nestedValue !== null
      ) {
        return true;
      }
      return hasSyncImportOrBulkSignal(nestedValue, depth + 1);
    },
  );
}

function reserveAutoAnnotationRequestSlot(): boolean {
  const now = Date.now();
  while (
    autoAnnotationRequestTimes.length > 0 &&
    now - autoAnnotationRequestTimes[0] > AUTO_ANNOTATION_REQUEST_WINDOW_MS
  ) {
    autoAnnotationRequestTimes.shift();
  }
  if (
    autoAnnotationRequestTimes.length >= MAX_AUTO_ANNOTATION_REQUESTS_PER_WINDOW
  ) {
    return false;
  }
  autoAnnotationRequestTimes.push(now);
  return true;
}

function recordRecentReaderSelection(
  event: ReaderSelectionEvent,
  sourceText: string,
) {
  pruneRecentReaderSelections();
  recentReaderSelections.push({
    itemID: event.reader?.itemID,
    sourceText,
    timestamp: Date.now(),
  });
  if (recentReaderSelections.length > MAX_RECENT_READER_SELECTIONS) {
    recentReaderSelections.splice(
      0,
      recentReaderSelections.length - MAX_RECENT_READER_SELECTIONS,
    );
  }
}

function matchesRecentReaderSelection(
  item: Zotero.Item,
  sourceText: string,
): boolean {
  pruneRecentReaderSelections();
  const parentID = getItemParentID(item);
  if (typeof parentID !== "number") {
    return false;
  }
  return recentReaderSelections.some((selection) => {
    return selection.itemID === parentID && selection.sourceText === sourceText;
  });
}

function pruneRecentReaderSelections() {
  const cutoff = Date.now() - RECENT_READER_SELECTION_WINDOW_MS;
  while (
    recentReaderSelections.length > 0 &&
    recentReaderSelections[0].timestamp < cutoff
  ) {
    recentReaderSelections.shift();
  }
}

function isAutoTranslatableAnnotationItem(
  item: Zotero.Item | undefined,
): item is Zotero.Item {
  return Boolean(item?.isAnnotation() && item.isEditable("edit"));
}

function getAnnotationItemSourceText(item: Zotero.Item): string {
  return typeof item.annotationText === "string"
    ? item.annotationText.trim()
    : "";
}

function enqueueAutoAnnotationTranslation(
  item: Zotero.Item,
  sourceText: string,
) {
  if (
    pendingAutoAnnotationItemIDs.has(item.id) ||
    autoAnnotationQueue.length >= MAX_AUTO_ANNOTATION_QUEUE_SIZE ||
    !reserveAutoAnnotationRequestSlot()
  ) {
    return;
  }
  pendingAutoAnnotationItemIDs.add(item.id);
  autoAnnotationQueue.push({
    id: ++nextAutoAnnotationJobID,
    annotation: createAnnotationContextFromItem(item),
    itemID: item.id,
    sourceText,
  });
  void processAutoAnnotationQueue();
}

async function processAutoAnnotationQueue() {
  if (autoAnnotationProcessing) {
    return;
  }
  autoAnnotationProcessing = true;
  try {
    while (registered && autoAnnotationQueue.length > 0) {
      const job = autoAnnotationQueue.shift();
      if (!job) {
        continue;
      }
      try {
        await processAutoAnnotationJob(job);
      } finally {
        pendingAutoAnnotationItemIDs.delete(job.itemID);
      }
      if (registered && autoAnnotationQueue.length > 0) {
        await Zotero.Promise.delay(AUTO_ANNOTATION_REQUEST_DELAY_MS);
      }
    }
  } finally {
    autoAnnotationProcessing = false;
  }
}

async function processAutoAnnotationJob(job: AutoAnnotationJob) {
  if (getPref("selectionTranslationAutoTranslateNewAnnotations") !== true) {
    return;
  }
  const item = Zotero.Items.get(job.itemID);
  if (!isAutoTranslatableAnnotationItem(item)) {
    return;
  }
  if (
    getAnnotationItemSourceText(item) !== job.sourceText ||
    !matchesRecentReaderSelection(item, job.sourceText) ||
    hasExistingAnnotationTranslationBlock(item)
  ) {
    return;
  }

  const state = createAutoAnnotationState(job, item);
  await translateAnnotationState(state, job.sourceText, {
    autoWrite: "always",
    autoWriteSuccessKey:
      "selection-translation-new-annotation-auto-translate-success",
    canAutoWrite: () => isAutoAnnotationJobCurrent(job, state),
    isCurrent: () => isAutoAnnotationJobCurrent(job, state),
    reveal: false,
  });
}

function createAutoAnnotationState(
  job: AutoAnnotationJob,
  item: Zotero.Item,
): SelectionState {
  return {
    id: ++nextSessionID,
    requestID: 0,
    itemID: getItemParentID(item) ?? item.id,
    sourceText: job.sourceText,
    translatedText: "",
    targetLanguage: `${getPref("targetLanguage") || "zh-CN"}`,
    model: normalizeSelectionTranslationModel(
      getPref("selectionTranslationModel"),
    ),
    thinkingMode: normalizeSelectionTranslationThinkingMode(
      getPref("selectionTranslationThinkingMode"),
    ),
    status: "idle",
    message: getString("selection-translation-new-annotation-loading"),
    annotation: job.annotation,
  };
}

function isAutoAnnotationJobCurrent(
  job: AutoAnnotationJob,
  state: SelectionState,
): boolean {
  if (
    !registered ||
    latestState?.id !== state.id ||
    getPref("selectionTranslationAutoTranslateNewAnnotations") !== true
  ) {
    return false;
  }
  const item = Zotero.Items.get(job.itemID);
  return (
    isAutoTranslatableAnnotationItem(item) &&
    getAnnotationItemSourceText(item) === job.sourceText &&
    !hasExistingAnnotationTranslationBlock(item)
  );
}

function createAnnotationContextFromItem(item: Zotero.Item): AnnotationContext {
  return {
    key: item.key,
    libraryID: item.libraryID,
    itemID: item.id,
    readOnly: !item.isEditable("edit"),
  };
}

function getItemParentID(item: Zotero.Item): number | undefined {
  const parentedItem = item as Zotero.Item & {
    parentID?: number;
    parentItemID?: number;
  };
  return parentedItem.parentItemID ?? parentedItem.parentID;
}

async function translateForSession(session: PopupSession, apiKey: string) {
  const requestedModel = session.model;
  const requestedThinkingMode = session.thinkingMode;
  const requestedTargetLanguage = session.targetLanguage;
  const requestedSourceText = session.sourceText;
  const requestID = ++nextRequestID;
  session.requestID = requestID;
  latestState = toSelectionState(session);
  refreshItemPaneSections();
  const result = await requestDeepSeekSelectionTranslation({
    apiKey,
    text: requestedSourceText,
    targetLanguage: requestedTargetLanguage,
    model: requestedModel,
    thinkingMode: requestedThinkingMode,
  }).catch(() => {
    return { ok: false as const, code: "server" as const };
  });

  if (
    !isActive(session) ||
    session.requestID !== requestID ||
    session.sourceText !== requestedSourceText
  ) {
    return;
  }

  if (!result.ok) {
    updateSession(session, {
      status: result.code === "empty" ? "empty" : "error",
      message: getProviderErrorMessage(result.code),
    });
    return;
  }

  updateSession(session, {
    status: "success",
    translatedText: result.translation,
    message: getString("selection-translation-success"),
    model: requestedModel,
    thinkingMode: requestedThinkingMode,
    targetLanguage: requestedTargetLanguage,
  });
}

function updateSession(
  session: PopupSession,
  patch: Partial<
    Pick<
      PopupSession,
      | "sourceText"
      | "status"
      | "translatedText"
      | "message"
      | "model"
      | "thinkingMode"
      | "targetLanguage"
    >
  >,
) {
  Object.assign(session, patch);
  latestState = toSelectionState(session);
  refreshItemPaneSections();
}

function toSelectionState(session: PopupSession): SelectionState {
  return {
    id: session.id,
    requestID: session.requestID,
    itemID: session.itemID,
    sourceText: session.sourceText,
    translatedText: session.translatedText,
    targetLanguage: session.targetLanguage,
    model: session.model,
    thinkingMode: session.thinkingMode,
    status: session.status,
    message: session.message,
    annotation: session.annotation,
  };
}

function getStateDocument(state: SelectionState): Document {
  if ("doc" in state) {
    return (state as PopupSession).doc;
  }
  return Zotero.getMainWindow().document;
}

function isAnnotationAutoWriteEnabled(): boolean {
  return getPref("selectionTranslationAutoWriteAnnotationComment") === true;
}

function canWriteAnnotationCommentState(state: SelectionState): boolean {
  if (!state.annotation || state.annotation.readOnly || !state.translatedText) {
    return false;
  }
  return true;
}

async function writeTranslationToAnnotationCommentState(
  state: SelectionState,
  options: {
    canMutate?: () => boolean;
    successKey?: string;
  } = {},
): Promise<boolean> {
  if (!state.translatedText.trim()) {
    setStateMessage(state, getString("selection-translation-annotation-error"));
    return false;
  }
  if (!state.annotation) {
    setStateMessage(
      state,
      getString("selection-translation-annotation-unavailable"),
    );
    return false;
  }
  const item = getCurrentAnnotationItem(state.annotation);
  if (!item) {
    setStateMessage(
      state,
      getString("selection-translation-annotation-unavailable"),
    );
    return false;
  }
  const previousComment = item.annotationComment || "";
  const nextComment = buildAnnotationComment(
    previousComment,
    state.translatedText,
  );
  if (!nextComment.ok) {
    setStateMessage(
      state,
      getString("selection-translation-annotation-marker-error"),
    );
    return false;
  }
  if (options.canMutate && !options.canMutate()) {
    return false;
  }

  return saveAnnotationChange(
    state,
    item,
    () => {
      item.annotationComment = nextComment.comment;
    },
    () => {
      item.annotationComment = previousComment;
    },
    options.successKey ?? "selection-translation-annotation-success",
    options.canMutate,
  );
}

async function maybeAutoWriteAnnotationComment(
  state: SelectionState,
  options: {
    canMutate?: () => boolean;
    requirePref: boolean;
    successKey: string;
  },
): Promise<boolean> {
  if (options.requirePref && !isAnnotationAutoWriteEnabled()) {
    return false;
  }
  if (!canWriteAnnotationCommentState(state)) {
    return false;
  }
  return writeTranslationToAnnotationCommentState(state, {
    canMutate: options.canMutate,
    successKey: options.successKey,
  });
}

async function saveAnnotationChange(
  state: SelectionState,
  item: Zotero.Item,
  apply: () => void,
  rollback: () => void,
  successKey: string,
  canMutate?: () => boolean,
): Promise<boolean> {
  try {
    if (canMutate && !canMutate()) {
      return false;
    }
    apply();
    const saveResult = await item.saveTx();
    if (saveResult === false) {
      rollback();
      setStateMessage(
        state,
        getString("selection-translation-annotation-error"),
      );
      return false;
    }
    try {
      state.annotation?.reader?.setAnnotations?.([item]);
    } catch (_refreshError) {
      // Zotero notifiers should still persist the saved annotation change.
    }
    setStateMessage(state, getString(successKey));
    return true;
  } catch (_error) {
    rollback();
    setStateMessage(state, getString("selection-translation-annotation-error"));
    return false;
  }
}

function getCurrentAnnotationItem(
  annotation: AnnotationContext,
): Zotero.Item | undefined {
  const item =
    typeof annotation.itemID === "number"
      ? Zotero.Items.get(annotation.itemID)
      : Zotero.Items.getByLibraryAndKey(annotation.libraryID, annotation.key);
  if (!item || !item.isAnnotation() || !item.isEditable("edit")) {
    return undefined;
  }
  if (
    annotation.reader?.annotationItemIDs &&
    !annotation.reader.annotationItemIDs.includes(item.id)
  ) {
    return undefined;
  }
  return item;
}

function buildAnnotationComment(
  currentComment: string,
  translatedText: string,
): { ok: true; comment: string } | { ok: false } {
  const normalizedTranslation = translatedText.replace(/\r\n?/g, "\n");
  if (containsExactMarkerLine(normalizedTranslation)) {
    return { ok: false };
  }

  const normalizedComment = currentComment.replace(/\r\n?/g, "\n");
  const lines = normalizedComment ? normalizedComment.split("\n") : [];
  const blocks = getAnnotationTranslationBlocks(lines);
  if (!blocks.ok) {
    return { ok: false };
  }

  const blockLines = [
    ANNOTATION_BLOCK_START,
    normalizedTranslation,
    ANNOTATION_BLOCK_END,
  ];

  if (blocks.blocks.length === 0) {
    const block = blockLines.join("\n");
    return {
      ok: true,
      comment: normalizedComment ? `${normalizedComment}\n\n${block}` : block,
    };
  }

  const output: string[] = [];
  let blockIndex = 0;
  for (let index = 0; index < lines.length; index++) {
    const block = blocks.blocks[blockIndex];
    if (block && index === block.start) {
      if (blockIndex === 0) {
        output.push(...blockLines);
      }
      index = block.end;
      blockIndex++;
      continue;
    }
    output.push(lines[index]);
  }

  return { ok: true, comment: output.join("\n") };
}

function containsExactMarkerLine(text: string): boolean {
  return text.split("\n").some((line) => {
    return line === ANNOTATION_BLOCK_START || line === ANNOTATION_BLOCK_END;
  });
}

function getAnnotationTranslationBlocks(
  lines: string[],
): { ok: true; blocks: Array<{ start: number; end: number }> } | { ok: false } {
  const blocks: Array<{ start: number; end: number }> = [];
  let openStart: number | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === ANNOTATION_BLOCK_START) {
      if (openStart !== undefined) {
        return { ok: false };
      }
      openStart = index;
      continue;
    }
    if (line === ANNOTATION_BLOCK_END) {
      if (openStart === undefined) {
        return { ok: false };
      }
      blocks.push({ start: openStart, end: index });
      openStart = undefined;
    }
  }

  if (openStart !== undefined) {
    return { ok: false };
  }
  return { ok: true, blocks };
}

function hasExistingAnnotationTranslationBlock(item: Zotero.Item): boolean {
  const currentComment = item.annotationComment || "";
  const normalizedComment = currentComment.replace(/\r\n?/g, "\n");
  const lines = normalizedComment ? normalizedComment.split("\n") : [];
  const blocks = getAnnotationTranslationBlocks(lines);
  return !blocks.ok || blocks.blocks.length > 0;
}

function retry(session: PopupSession) {
  const sourceText = session.sourceText.trim();
  if (!sourceText) {
    updateSession(session, {
      sourceText,
      translatedText: "",
      status: "empty",
      message: getString("selection-translation-error-empty"),
    });
    return;
  }
  if (sourceText.length > MAX_SELECTION_LENGTH) {
    updateSession(session, {
      sourceText,
      translatedText: "",
      status: "length",
      message: getString("selection-translation-error-length"),
    });
    return;
  }
  const apiKey =
    `${getPref("selectionTranslationDeepSeekApiKey") || ""}`.trim();
  if (!apiKey) {
    updateSession(session, {
      status: "missing-key",
      message: getString("selection-translation-missing-key"),
    });
    return;
  }
  session.targetLanguage = `${getPref("targetLanguage") || "zh-CN"}`;
  session.sourceText = sourceText;
  session.model = normalizeSelectionTranslationModel(
    getPref("selectionTranslationModel"),
  );
  session.thinkingMode = normalizeSelectionTranslationThinkingMode(
    getPref("selectionTranslationThinkingMode"),
  );
  updateSession(session, {
    status: "loading",
    translatedText: "",
    message: getString("selection-translation-loading"),
  });
  void translateForSession(session, apiKey);
}

function translateStateFromItemPane(state: SelectionState, sourceText: string) {
  const normalizedSource = sourceText.trim();
  if (activeSession?.id === state.id) {
    updateSession(activeSession, {
      sourceText: normalizedSource,
      translatedText: "",
    });
    retry(activeSession);
    return;
  }

  const nextState = {
    ...state,
    sourceText: normalizedSource,
    translatedText: "",
    targetLanguage: `${getPref("targetLanguage") || "zh-CN"}`,
    model: normalizeSelectionTranslationModel(
      getPref("selectionTranslationModel"),
    ),
    thinkingMode: normalizeSelectionTranslationThinkingMode(
      getPref("selectionTranslationThinkingMode"),
    ),
    status: "idle" as const,
    message: "",
  };
  void translateAnnotationState(nextState, normalizedSource, {
    isCurrent: () => latestState?.id === nextState.id,
  });
}

function copyTranslatedText(state: SelectionState) {
  if (!state.translatedText) {
    setStateMessage(state, getString("selection-translation-copy-error"));
    return;
  }
  try {
    new ztoolkit.Clipboard()
      .addText(state.translatedText, "text/unicode")
      .copy();
    setStateMessage(state, getString("selection-translation-copy-success"));
  } catch (_error) {
    setStateMessage(state, getString("selection-translation-copy-error"));
  }
}

function toggleReadAloud(state: SelectionState) {
  const doc = getStateDocument(state);
  const speechSynthesis = doc.defaultView?.speechSynthesis;
  const sessionWindow = doc.defaultView as
    | (Window & {
        SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
      })
    | null;
  const SpeechSynthesisUtteranceCtor =
    sessionWindow?.SpeechSynthesisUtterance ??
    globalThis.SpeechSynthesisUtterance;
  if (!speechSynthesis || !SpeechSynthesisUtteranceCtor) {
    setStateMessage(
      state,
      getString("selection-translation-read-aloud-unavailable"),
    );
    return;
  }

  if (activeSpeech?.ownerID === state.id) {
    activeSpeech.synth.cancel();
    activeSpeech = undefined;
    return;
  }

  cleanupSpeech();
  const utterance = new SpeechSynthesisUtteranceCtor(state.translatedText);
  utterance.lang = state.targetLanguage;
  const localVoice = findLocalSpeechVoice(
    speechSynthesis,
    state.targetLanguage,
  );
  if (!localVoice) {
    setStateMessage(
      state,
      getString("selection-translation-read-aloud-unavailable"),
    );
    return;
  }
  utterance.voice = localVoice;
  utterance.onerror = () => {
    setStateMessage(state, getString("selection-translation-read-aloud-error"));
  };
  utterance.onend = () => {
    if (activeSpeech?.ownerID === state.id) {
      activeSpeech = undefined;
    }
  };
  activeSpeech = { ownerID: state.id, synth: speechSynthesis };
  speechSynthesis.speak(utterance);
}

function findLocalSpeechVoice(
  speechSynthesis: SpeechSynthesis,
  targetLanguage: string,
): SpeechSynthesisVoice | undefined {
  const normalizedTargetLanguage = targetLanguage.toLowerCase();
  const targetLanguageBase = normalizedTargetLanguage.split("-")[0];
  const localVoices = speechSynthesis.getVoices().filter((voice) => {
    return voice.localService === true;
  });
  return (
    localVoices.find((voice) => {
      const normalizedVoiceLanguage = voice.lang.toLowerCase();
      return (
        normalizedVoiceLanguage === normalizedTargetLanguage ||
        normalizedVoiceLanguage.startsWith(`${targetLanguageBase}-`)
      );
    }) || localVoices[0]
  );
}

function setStateMessage(state: SelectionState, message: string) {
  state.message = message;
  if (activeSession?.id === state.id) {
    updateSession(activeSession, { message });
    return;
  }
  if (latestState?.id === state.id) {
    latestState = { ...latestState, message };
    refreshItemPaneSections();
  }
}

function updateLatestState(
  state: SelectionState,
  patch: Partial<
    Pick<
      SelectionState,
      | "sourceText"
      | "status"
      | "translatedText"
      | "message"
      | "model"
      | "thinkingMode"
      | "targetLanguage"
    >
  >,
) {
  if (latestState?.id !== state.id) {
    return;
  }
  Object.assign(state, patch);
  latestState = { ...state };
  refreshItemPaneSections();
}

function registerItemPaneSection() {
  const itemPaneManager = (
    Zotero as unknown as {
      ItemPaneManager?: {
        registerSection?: (options: unknown) => void;
        unregisterSection?: (id: string) => void;
      };
    }
  ).ItemPaneManager;
  if (!itemPaneManager?.registerSection || itemPaneRegistered) {
    return;
  }

  try {
    itemPaneManager.registerSection({
      paneID: ITEM_PANE_SECTION_ID,
      pluginID: addon.data.config.addonID,
      header: {
        l10nID: "selection-translation-title",
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      },
      sidenav: {
        l10nID: "selection-translation-title",
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      },
      onInit: (context: ItemPaneInitContext) => {
        registerItemPaneRefreshCallback(context);
        if (typeof context !== "function" && context.body) {
          itemPaneBodies.set(context.body, context.item);
          renderItemPaneBody(context.body, context.item);
        }
      },
      onDestroy: ({ body }: ItemPaneSectionRenderContext) => {
        if (body) {
          itemPaneBodies.delete(body);
        }
      },
      onRender: ({ body, item }: ItemPaneSectionRenderContext) => {
        if (body) {
          itemPaneBodies.set(body, item);
          renderItemPaneBody(body, item);
        }
      },
      onItemChange: ({ body, item }: ItemPaneSectionRenderContext) => {
        if (body) {
          itemPaneBodies.set(body, item);
          renderItemPaneBody(body, item);
        }
      },
    });
    itemPaneRegistered = true;
  } catch (_error) {
    itemPaneRegistered = false;
  }
}

function unregisterItemPaneSection() {
  const itemPaneManager = (
    Zotero as unknown as {
      ItemPaneManager?: { unregisterSection?: (id: string) => void };
    }
  ).ItemPaneManager;
  if (!itemPaneRegistered) {
    return;
  }
  try {
    itemPaneManager?.unregisterSection?.(ITEM_PANE_SECTION_ID);
  } catch (_error) {
    // Zotero will remove plugin UI on shutdown if explicit unregister is absent.
  }
  itemPaneRegistered = false;
  itemPaneBodies.clear();
  itemPaneRefreshCallbacks.clear();
}

function refreshItemPaneSections() {
  itemPaneRefreshCallbacks.forEach((refresh) => {
    try {
      refresh();
    } catch (_error) {
      itemPaneRefreshCallbacks.delete(refresh);
    }
  });
  itemPaneBodies.forEach((item, body) => renderItemPaneBody(body, item));
}

function revealItemPaneSection(state: SelectionState) {
  try {
    state.annotation?.reader?.focus?.();
  } catch (_error) {
    // Zotero Reader focus APIs are internal and version-sensitive. Translation
    // must continue even if focusing the Reader surface is unavailable.
  }
  refreshItemPaneSections();
  itemPaneBodies.forEach((item, body) => {
    if (canRenderStateForItemPane(state, item)) {
      revealItemPaneBody(body);
    }
  });
}

function revealItemPaneBody(body: HTMLElement) {
  try {
    const itemDetails = body.closest("item-details") as
      | (HTMLElement & {
          scrollToPane?: (paneID: string, behavior?: ScrollBehavior) => void;
        })
      | null;
    itemDetails?.scrollToPane?.(ITEM_PANE_SECTION_ID, "smooth");

    const section = body.closest(
      `collapsible-section[data-pane="${ITEM_PANE_SECTION_ID}"]`,
    ) as (HTMLElement & { open?: boolean }) | null;
    if (section && "open" in section) {
      section.open = true;
    }
    section?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  } catch (_error) {
    // Reader item pane reveal APIs are internal and may differ by Zotero build.
    // Do not fall back to main Zotero item pane selection.
  }
}

function registerItemPaneRefreshCallback(context: ItemPaneInitContext) {
  const refresh = typeof context === "function" ? context : context.refresh;
  if (typeof refresh === "function") {
    itemPaneRefreshCallbacks.add(refresh);
  }
}

function renderItemPaneBody(body: HTMLElement, item?: Zotero.Item) {
  const doc = body.ownerDocument;
  if (!doc) {
    return;
  }
  injectStyles(doc);
  body.replaceChildren();
  body.classList.add(`${ROOT_CLASS}__item-pane`);

  const state = latestState;
  if (!state || !canRenderStateForItemPane(state, item)) {
    const empty = doc.createElement("p");
    empty.textContent = getString("selection-translation-item-pane-empty");
    body.append(empty);
    return;
  }

  const status = doc.createElement("p");
  status.className = `${ROOT_CLASS}__status`;
  status.textContent = state.message || getStatusText(state.status);

  const sourceEditor = createItemPaneSourceEditor(doc, state);

  body.append(
    status,
    createItemPaneMetadata(doc, state),
    sourceEditor.block,
    createItemPaneBlock(
      doc,
      "selection-translation-result",
      state.translatedText || getStatusText(state.status),
    ),
  );

  body.append(createItemPaneActions(doc, state, sourceEditor.input));
}

function canRenderStateForItemPane(
  state: SelectionState,
  item: Zotero.Item | undefined,
): boolean {
  if (!item || typeof state.itemID !== "number") {
    return false;
  }
  if (state.itemID === item.id) {
    return true;
  }

  const stateItem = Zotero.Items.get(state.itemID);
  if (isChildItemOf(stateItem, item.id)) {
    return true;
  }
  const annotationItem = state.annotation
    ? getCurrentAnnotationItem(state.annotation)
    : undefined;
  return isChildItemOf(annotationItem, item.id);
}

function createReaderEventGuard(event: ReaderSelectionEvent): ReaderEventGuard {
  const win = event.doc.defaultView;
  let alive = Boolean(win && !win.closed);
  const markDead = () => {
    alive = false;
  };
  win?.addEventListener("pagehide", markDead, { once: true });
  win?.addEventListener("unload", markDead, { once: true });
  return {
    isAlive: () =>
      alive &&
      registered &&
      Boolean(win && !win.closed && event.doc.defaultView === win),
    dispose: () => {
      win?.removeEventListener("pagehide", markDead);
      win?.removeEventListener("unload", markDead);
      alive = false;
    },
  };
}

function isCurrentReaderEventRequest(
  event: ReaderSelectionEvent,
  state: SelectionState,
  sourceText: string,
): boolean {
  const win = event.doc.defaultView;
  const annotation = state.annotation
    ? getCurrentAnnotationItem(state.annotation)
    : undefined;
  return Boolean(
    registered &&
      latestState?.id === state.id &&
      win &&
      !win.closed &&
      (!annotation || getAnnotationItemSourceText(annotation) === sourceText),
  );
}

function isChildItemOf(
  item: Zotero.Item | undefined,
  parentID: number,
): boolean {
  const childItem = item as
    | (Zotero.Item & { parentItemID?: number })
    | undefined;
  return childItem?.parentItemID === parentID;
}

function createItemPaneMetadata(
  doc: Document,
  state: SelectionState,
): HTMLElement {
  const metadata = doc.createElement("p");
  metadata.className = `${ROOT_CLASS}__metadata`;
  metadata.textContent = `${getString("selection-translation-target-language")}: ${state.targetLanguage} · DeepSeek ${state.model} · ${getString(`selection-translation-thinking-mode-${state.thinkingMode}`)}`;
  return metadata;
}

function createItemPaneBlock(
  doc: Document,
  labelKey: string,
  value: string,
): HTMLElement {
  const block = doc.createElement("section");
  block.className = `${ROOT_CLASS}__item-pane-block`;
  const label = doc.createElement("strong");
  label.textContent = getString(labelKey);
  const content = doc.createElement("div");
  content.textContent = value;
  block.append(label, content);
  return block;
}

function createItemPaneSourceEditor(
  doc: Document,
  state: SelectionState,
): { block: HTMLElement; input: HTMLTextAreaElement } {
  const block = doc.createElement("section");
  block.className = `${ROOT_CLASS}__item-pane-block`;
  const label = doc.createElement("label");
  label.textContent = getString("selection-translation-source");
  const textarea = doc.createElement("textarea");
  textarea.className = `${ROOT_CLASS}__source-input`;
  textarea.value = state.sourceText;
  textarea.rows = 4;
  textarea.addEventListener("input", () => {
    state.sourceText = textarea.value;
    if (latestState?.id === state.id) {
      latestState = { ...state, sourceText: textarea.value };
    }
    if (activeSession?.id === state.id) {
      activeSession.sourceText = textarea.value;
    }
  });
  label.append(textarea);
  block.append(label);
  return { block, input: textarea };
}

function createItemPaneActions(
  doc: Document,
  state: SelectionState,
  sourceInput: HTMLTextAreaElement,
): HTMLElement {
  const actions = doc.createElement("div");
  actions.className = `${ROOT_CLASS}__actions`;
  const actionButtons: HTMLButtonElement[] = [];
  actionButtons.push(
    createItemPaneButton(doc, "selection-translation-action", () =>
      translateStateFromItemPane(state, sourceInput.value),
    ),
  );
  if (state.translatedText) {
    actionButtons.push(
      createItemPaneButton(doc, "selection-translation-copy", () =>
        copyTranslatedText(state),
      ),
      createItemPaneButton(doc, "selection-translation-read-aloud", () =>
        toggleReadAloud(state),
      ),
    );
  }
  actions.append(...actionButtons);
  if (canWriteAnnotationCommentState(state)) {
    actions.append(
      createItemPaneButton(
        doc,
        "selection-translation-annotation-comment",
        () => {
          state.sourceText = sourceInput.value;
          if (latestState?.id === state.id) {
            latestState = { ...state };
          }
          void writeTranslationToAnnotationCommentState(state);
        },
      ),
    );
  }
  return actions;
}

function createItemPaneButton(
  doc: Document,
  labelKey: string,
  listener: () => void,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = getString(labelKey);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    listener();
  });
  return button;
}

function cleanupActiveSession() {
  cleanupSpeech();
  if (activeSession?.unloadWindow && activeSession.unloadListener) {
    activeSession.unloadWindow.removeEventListener(
      "unload",
      activeSession.unloadListener,
    );
  }
  activeSession?.root.remove();
  activeSession = undefined;
}

function bindReaderUnload(session: PopupSession) {
  const unloadWindow = session.doc.defaultView;
  if (!unloadWindow) {
    return;
  }
  const unloadListener = () => {
    if (activeSession?.id === session.id) {
      cleanupActiveSession();
    }
  };
  unloadWindow.addEventListener("unload", unloadListener, { once: true });
  session.unloadWindow = unloadWindow;
  session.unloadListener = unloadListener;
}

function cleanupSpeech() {
  activeSpeech?.synth.cancel();
  activeSpeech = undefined;
}

function isActive(session: PopupSession): boolean {
  return (
    registered &&
    activeSession?.id === session.id &&
    latestState?.id === session.id
  );
}

function getStatusText(status: TranslationStatus): string {
  switch (status) {
    case "loading":
      return getString("selection-translation-loading");
    case "success":
      return getString("selection-translation-success");
    case "missing-key":
      return getString("selection-translation-missing-key");
    case "length":
      return getString("selection-translation-error-length");
    case "empty":
      return getString("selection-translation-error-empty");
    case "error":
      return getString("selection-translation-error-generic");
    default:
      return getString("selection-translation-ready");
  }
}

function getProviderErrorMessage(code: SelectionTranslationErrorCode): string {
  switch (code) {
    case "auth":
      return getString("selection-translation-error-auth");
    case "rate-limit":
      return getString("selection-translation-error-rate-limit");
    case "bad-request":
      return getString("selection-translation-error-bad-request");
    case "server":
      return getString("selection-translation-error-server");
    case "timeout":
      return getString("selection-translation-error-timeout");
    case "network":
      return getString("selection-translation-error-network");
    case "empty":
      return getString("selection-translation-error-empty");
    case "malformed":
      return getString("selection-translation-error-malformed");
    default:
      return getString("selection-translation-error-generic");
  }
}

function injectStyles(doc: Document) {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${ROOT_CLASS}__popup-entry {
      align-items: center;
      display: inline-flex;
      margin-inline-start: 6px;
      position: relative;
      vertical-align: middle;
    }
    .${ROOT_CLASS}__translate-button {
      appearance: auto;
      background: var(--material-button-background, ButtonFace);
      border: 1px solid var(--border-color, ButtonBorder);
      border-radius: 4px;
      color: var(--fill-primary, ButtonText);
      font: menu;
      min-height: 24px;
      padding: 3px 9px;
    }
    .${ROOT_CLASS}__annotation-header-button {
      appearance: auto;
      font: menu;
      margin-inline-start: 4px;
      min-height: 22px;
      padding: 2px 6px;
    }
    .${ROOT_CLASS}__panel-header { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .${ROOT_CLASS}__status { margin: 4px 0; }
    .${ROOT_CLASS}__metadata { color: var(--fill-secondary, #5f6368); margin: 8px 0; }
    .${ROOT_CLASS}__result-label { display: grid; gap: 4px; margin-block: 8px; }
    .${ROOT_CLASS}__result {
      box-sizing: border-box;
      font: menu;
      max-height: 96px;
      resize: vertical;
      width: 100%;
    }
    .${ROOT_CLASS}__actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .${ROOT_CLASS}__item-pane { display: grid; gap: 8px; }
    .${ROOT_CLASS}__item-pane-block {
      border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12));
      border-radius: 6px;
      display: grid;
      gap: 4px;
      padding: 8px;
    }
    .${ROOT_CLASS}__item-pane-block div {
      max-height: 120px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .${ROOT_CLASS}__source-input {
      box-sizing: border-box;
      font: menu;
      min-height: 72px;
      resize: vertical;
      width: 100%;
    }
  `;
  const styleContainer = doc.head || doc.documentElement;
  styleContainer?.append(style);
}
