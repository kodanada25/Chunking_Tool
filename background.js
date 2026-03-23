// Content Slicer — background service worker
// Side panel is enabled only on allowed sites

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ALLOWED SITES — add your domains / subdomains here
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Examples:
//   'example.com'             → matches example.com only
//   'support.example.com'    → matches that exact subdomain
//   '.example.com'           → matches ALL subdomains (*.example.com)
//
const ALLOWED_HOSTS = [
  'fjservicedesk.lightning.force.com'
];
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isAllowed(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_HOSTS.some(pattern => {
      if (!pattern) return false;
      if (pattern.startsWith('.')) {
        return hostname.endsWith(pattern) || hostname === pattern.slice(1);
      }
      return hostname === pattern;
    });
  } catch {
    return false;
  }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    chrome.sidePanel.setOptions({
      tabId,
      enabled: isAllowed(tab.url)
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  chrome.sidePanel.setOptions({
    tabId,
    enabled: isAllowed(tab.url)
  });
});
