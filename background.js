// Content Slicer — background service worker
// Opens the native Chrome Side Panel when the toolbar icon is clicked

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error('SidePanel error:', err));
