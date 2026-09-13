import { NeuralStreetDriver } from './neural-drive.js';

export class ManualControl {
  constructor(nav) { this.nav = nav; this.app = nav.app; this.enabled = false; this.serial = 0; this.lastImage = 0; }
  halt(reset = false) {
    this.enabled = false; this.serial++; if (reset) this.driver = null; this.imageBusy = false;
    this.app.views.eyes.holdNavigation?.();
  }
  async enable() {
    if (this.enabled) return true;
    const nav = this.nav;
    if (nav.busy) return false;
    if (this.app.ws?.readyState !== 1) { this.message('Wait for the brain connection.'); return false; }
    const serial = ++this.serial;
    try {
      if (this.driver?.node || this.driver?.segment) { this.enabled = true; this.nav.setState('manual'); this.message('Manual brain control resumed.'); await this.photo(); return this.enabled && serial === this.serial; }
      if (!nav.streets || !nav.currentNode) await nav.placeForManual();
      if (serial !== this.serial) return false;
      const current = await nav.environmentNode(nav.currentNode.id, nav.epoch);
      if (serial !== this.serial) return false;
      this.driver = new NeuralStreetDriver(current, this.app.views.map.w.heading);
      this.enabled = true; this.lastImage = 0; this.lastHeading = Infinity;
      nav.setState('manual'); nav.status('Manual brain control. Learn trip or Try from memory switches back to the journey experiment.');
      this.message('Manual brain control. Turns take effect at photo stops.');
      await this.photo();
      return this.enabled && serial === this.serial;
    } catch (error) { if (serial === this.serial) this.message(error.message); return false; }
  }
  message(text) { const el = document.getElementById('manual-status'); if (el) el.textContent = text; }
  tick(dt) {
    if (!this.enabled || this.nav.busy || !this.driver) return;
    if (this.imageBusy) { this.app.views.map.w.speed = 0; return; }
    const nav = this.nav, map = this.app.views.map;
    const playing = this.app.frame?.playing && this.app.ws?.readyState === 1;
    if (!playing) { map.w.speed = 0; this.message(`Paused · ${(this.driver.total || 0).toFixed(1)} m`); return; }
    const result = this.driver.tick(dt, this.app.ema, playing);
    if (result) {
      if (Number.isFinite(result.lat)) map.snapTo(result.lat, result.lng);
      map.w.heading = result.heading; map.w.speed = result.speed;
      if (result.blocked) this.message('No street ahead. Stop Walk, turn to face a street, then Walk again.');
      else this.message(`${playing ? 'Manual' : 'Paused'} · ${(this.driver.total || 0).toFixed(1)} m · ${result.speed.toFixed(1)} m/s`);
      if (result.arrived) this.arrive(result.arrived);
    }
    if (!playing || !this.driver.node || this.driver.segment || this.imageBusy) return;
    if (performance.now() - this.lastImage > 1800 && Math.abs(map.w.heading - this.lastHeading) > 15) this.photo();
  }
  async arrive(id) {
    const serial = this.serial;
    this.nav.currentNode = this.nav.nodes.get(id);
    try {
      const node = await this.nav.environmentNode(id, this.nav.epoch);
      if (serial !== this.serial || !this.enabled) return;
      this.driver.node = node; this.nav.currentNode = node; this.lastHeading = Infinity;
      this.app.views.map.adapter.setCenter(node.road.lat, node.road.lng);
      await this.photo();
    } catch (error) { if (serial === this.serial) { this.halt(); this.message(error.message); } }
  }
  async photo() {
    if (this.imageBusy || !this.driver?.node || !this.enabled) return;
    this.imageBusy = true; const serial = this.serial, node = this.driver.node, heading = this.app.views.map.w.heading;
    this.lastImage = performance.now(); this.lastHeading = heading;
    try {
      const image = await this.nav.image(node, heading, this.nav.epoch);
      if (serial === this.serial && this.enabled && !this.nav.busy) this.app.views.eyes.showNavigation(image.canvas, false, node.copyright);
    } catch (error) { if (serial === this.serial) { this.halt(); this.message(error.message); } }
    finally { if (serial === this.serial) this.imageBusy = false; }
  }
}
