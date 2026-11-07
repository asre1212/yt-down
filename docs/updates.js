// Keep update lifecycle separate from UI and test it without a browser.
export class AppUpdates {
  constructor({serviceWorker, isSafe, beforeReload, reload, notify = () => {}}) {
    Object.assign(this, {serviceWorker, isSafe, beforeReload, reload, notify});
    this.controlled = Boolean(serviceWorker.controller);
    this.reloadPending = false;
    this.reloading = false;
    this.sent = new WeakSet();
    serviceWorker.addEventListener('controllerchange', () => {
      if (!serviceWorker.controller) return;
      if (!this.controlled) { this.controlled = true; return; }
      this.reloadPending = true;
      this.resume();
    });
  }
  async start() {
    this.registration = await this.serviceWorker.register('./sw.js', {scope:'./', updateViaCache:'none'});
    const watch = () => {
      const worker = this.registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && this.serviceWorker.controller) {
          this.notify('Update downloaded. It will apply when the app is idle.');
          this.resume();
        }
        if (worker.state === 'redundant') this.notify('Update could not finish. Your current version is still available.');
      });
    };
    this.registration.addEventListener('updatefound', watch);
    watch();
    this.resume();
    await this.check();
  }
  resume() {
    if (this.reloading || !this.isSafe()) return;
    if (this.reloadPending) {
      if (!this.beforeReload()) return;
      this.reloading = true;
      this.reload();
      return;
    }
    const worker = this.registration?.waiting;
    if (worker && this.serviceWorker.controller && !this.sent.has(worker)) {
      this.sent.add(worker);
      worker.postMessage('SKIP_WAITING');
    }
  }
  async check(manual = false) {
    if (!this.registration) { if (manual) this.notify('Updates are not ready. Reopen the app online.'); return; }
    try {
      await this.registration.update();
      this.resume();
      if (manual) {
        if (this.registration.installing) this.notify('Downloading the app update…');
        else if (this.registration.waiting || this.reloadPending) this.notify('Update ready. Close Settings to apply it when the app is idle.');
        else this.notify('You have the latest installed version.');
      }
    } catch { if (manual) this.notify('Could not check online. Your installed version is still available.'); }
  }
}
