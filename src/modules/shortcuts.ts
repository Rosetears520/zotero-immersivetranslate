export function registerShortcuts() {
  ztoolkit.Keyboard.register((ev, data) => {
    if (data.type !== "keydown" || ev.repeat) {
      return;
    }

    const key = ev.key.toUpperCase();
    if (ev.shiftKey && key === "A") {
      const ids = Zotero.getActiveZoteroPane()
        .getSelectedItems()
        .map((item) => item.id);
      addon.hooks.onShortcuts("translate", ids);
    }
    if (ev.shiftKey && key === "T") {
      addon.hooks.onShortcuts("showTaskManager");
    }
  });
}
