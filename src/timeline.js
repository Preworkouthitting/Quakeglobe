// Playback state for the time scrubber. Owns no DOM and no three.js objects —
// main.js wires its callbacks to the markers and the timeline bar.
const PLAY_SECONDS = 40; // full window replays in ~40s

export class Timeline {
  constructor({ onTime, onPlayState } = {}) {
    this.onTime = onTime;             // (cutoffMs, {flash, atEnd}) =>
    this.onPlayState = onPlayState;   // (playing) =>
    this.start = 0;
    this.end = 0;
    this.cutoff = 0;
    this.playing = false;
  }

  setWindow(startMs, endMs) {
    this.start = startMs;
    this.end = Math.max(endMs, startMs + 1);
    this.cutoff = this.end;
    this.pause();
    this.emit(false);
  }

  frac() {
    return (this.cutoff - this.start) / (this.end - this.start);
  }

  play() {
    if (this.cutoff >= this.end) this.cutoff = this.start; // replay from start
    this.playing = true;
    this.onPlayState?.(true);
    this.emit(false);
  }

  pause() {
    this.playing = false;
    this.onPlayState?.(false);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  // Scrubbing seeks without flashes and pauses playback
  seek(frac) {
    this.pause();
    this.cutoff = this.start + (this.end - this.start) * frac;
    this.emit(false);
  }

  tick(dt) {
    if (!this.playing) return;
    this.cutoff += (this.end - this.start) / PLAY_SECONDS * dt;
    if (this.cutoff >= this.end) {
      this.cutoff = this.end;
      this.pause();
    }
    this.emit(true);
  }

  emit(flash) {
    this.onTime?.(this.cutoff, { flash, atEnd: this.cutoff >= this.end });
  }
}
