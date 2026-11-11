// Desktop notifications when the window is in the background: approvals, questions, finished runs.
// In the desktop app they are always allowed; in a browser, permission is asked on the first click.

let asked = false;
export function askNotifyPermission() {
  if (asked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  asked = true;
  void Notification.requestPermission();
}

export function notify(title: string, body: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.hasFocus()) return;
  try {
    const n = new Notification(title, { body: body.slice(0, 180), icon: '/icon-192.png', tag: title });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}
