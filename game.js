"use strict";

// ===== Utility =====
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function now() { return performance.now(); }

// ===== Audio =====
class Beeper {
  constructor() {
    this.enabled = true;
    this._ctx = null;
  }
  _ensure() {
    if (!this._ctx) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._ctx = ctx;
    }
  }
  enable(flag) {
    this.enabled = !!flag;
    if (this.enabled && this._ctx && this._ctx.state === "suspended") {
      this._ctx.resume();
    }
  }
  beep({ freq = 440, duration = 0.06, type = "sine", vol = 0.12 } = {}) {
    if (!this.enabled) return;
    this._ensure();
    const ctx = this._ctx;
    // Some browsers require user gesture to start audio; ignore errors silently
    try {
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(t0 + duration + 0.01);
    } catch (_) {}
  }
}

// ===== Level =====
class Obstacle {
  constructor(x, y, width, height, kind = "block") {
    this.x = x; this.y = y; this.width = width; this.height = height; this.kind = kind;
  }
  get right() { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
}

class Level {
  constructor() {
    this.obstacles = [];
  }
  static fromJSON(json) {
    const lvl = new Level();
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data)) {
        for (const o of data) {
          if (o && typeof o.x === "number" && typeof o.y === "number" && typeof o.width === "number" && typeof o.height === "number") {
            lvl.obstacles.push(new Obstacle(o.x, o.y, o.width, o.height, o.kind || "block"));
          }
        }
      }
    } catch (_) {}
    return lvl;
  }
  toJSON() {
    return JSON.stringify(this.obstacles.map(o => ({ x: o.x, y: o.y, width: o.width, height: o.height, kind: o.kind })), null, 2);
  }
}

// ===== Player =====
class Player {
  constructor(x, y, size) {
    this.spawnX = x; this.spawnY = y; this.size = size;
    this.x = x; this.y = y;
    this.velocityX = 0; this.velocityY = 0;
    this.grounded = false;
    this.dashAvailable = true;
    this.invincibleUntil = 0;
  }
  resetToCheckpoint(x, y) {
    this.x = x; this.y = y; this.velocityX = 0; this.velocityY = 0;
    this.grounded = false; this.dashAvailable = true; this.invincibleUntil = now() + 250;
  }
  jump(power = 15) {
    if (this.grounded) {
      this.velocityY = -power;
      this.grounded = false;
      return true;
    }
    return false;
  }
  dash() {
    if (this.dashAvailable) {
      this.velocityX = Math.max(this.velocityX, 18);
      this.dashAvailable = false;
      this.invincibleUntil = now() + 200;
      return true;
    }
    return false;
  }
}

// ===== Game =====
class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.baseWidth = 960; this.baseHeight = 540;
    this.resizeObserver = null;

    // Colors
    this.bgColor = "#0b1220";
    this.playerColor = "#34d399";
    this.obstacleColor = "#f59e0b";

    // World
    this.gravity = 0.85;
    this.frictionX = 0.9;
    this.groundY = this.baseHeight - 70;
    this.scrollX = 0; // world offset
    this.speedBase = 8.5;
    this.speedMultiplier = 1.0;

    // State
    this.running = false;
    this.paused = false;
    this.practice = false;
    this.checkpoint = null; // {x, y, scrollX}
    this.deaths = 0;

    // Entities
    this.player = new Player(140, this.groundY - 44, 36);
    this.level = new Level();

    // Systems
    this.beeper = new Beeper();
    this.inputs = this._createInputs();

    // Editor
    this.editorEnabled = false;
    this.placeDistance = 1200;
    this.tool = "block";

    this._initCanvas();
    this._bindUI();
    this._loadOrGenerateLevel();
    this._startLoop();
  }

  _initCanvas() {
    const resize = () => {
      const pr = this.pixelRatio;
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(480, Math.round(rect.width));
      const height = Math.round(width * (this.baseHeight / this.baseWidth));
      this.canvas.width = Math.round(width * pr);
      this.canvas.height = Math.round(height * pr);
      this.ctx.setTransform(pr, 0, 0, pr, 0, 0);
    };
    window.addEventListener("resize", resize);
    resize();
  }

  _bindUI() {
    const $ = (id) => document.getElementById(id);
    this.startBtn = $("startBtn");
    this.pauseBtn = $("pauseBtn");
    this.resetBtn = $("resetBtn");
    this.difficultySelect = $("difficultySelect");
    this.practiceToggle = $("practiceToggle");
    this.audioToggle = $("audioToggle");
    this.playerColorInput = $("playerColor");
    this.bgColorInput = $("bgColor");
    this.obstacleColorInput = $("obstacleColor");
    this.editorToggle = $("editorToggle");
    this.editorPanel = $("editorPanel");
    this.toolSelect = $("toolSelect");
    this.placeDistanceSlider = $("placeDistance");
    this.placeDistanceVal = $("placeDistanceVal");
    this.clearLevelBtn = $("clearLevelBtn");
    this.saveLevelBtn = $("saveLevelBtn");
    this.loadLevelBtn = $("loadLevelBtn");
    this.exportLevelBtn = $("exportLevelBtn");
    this.levelJson = $("levelJson");

    this.startBtn.addEventListener("click", () => this.start());
    this.pauseBtn.addEventListener("click", () => this.togglePause());
    this.resetBtn.addEventListener("click", () => this.reset());
    this.difficultySelect.addEventListener("change", () => {
      this.speedMultiplier = parseFloat(this.difficultySelect.value) || 1.0;
    });
    this.practiceToggle.addEventListener("change", () => {
      this.practice = this.practiceToggle.checked;
      if (!this.practice) this.checkpoint = null;
    });
    this.audioToggle.addEventListener("change", () => this.beeper.enable(this.audioToggle.checked));
    this.playerColorInput.addEventListener("input", () => this.playerColor = this.playerColorInput.value);
    this.bgColorInput.addEventListener("input", () => this.bgColor = this.bgColorInput.value);
    this.obstacleColorInput.addEventListener("input", () => this.obstacleColor = this.obstacleColorInput.value);
    this.editorToggle.addEventListener("change", () => this.setEditorEnabled(this.editorToggle.checked));
    this.toolSelect.addEventListener("change", () => this.tool = this.toolSelect.value);
    this.placeDistanceSlider.addEventListener("input", () => {
      this.placeDistance = parseInt(this.placeDistanceSlider.value, 10) || 1200;
      this.placeDistanceVal.textContent = `${this.placeDistance}px`;
    });
    this.clearLevelBtn.addEventListener("click", () => {
      this.level.obstacles = [];
      this._saveLevelToStorage();
    });
    this.saveLevelBtn.addEventListener("click", () => this._saveLevelToStorage());
    this.loadLevelBtn.addEventListener("click", () => this._loadLevelFromStorage());
    this.exportLevelBtn.addEventListener("click", () => this.levelJson.value = this.level.toJSON());

    // Canvas interactions
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.editorEnabled) {
        this._editorPlaceAtMouse(e);
      } else {
        if (!this.running) this.start();
        if (this.player.jump()) this.beeper.beep({ freq: 620, type: "triangle" });
      }
    });

    // Keyboard
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      switch (e.key.toLowerCase()) {
        case " ": case "spacebar": e.preventDefault(); if (this.player.jump()) this.beeper.beep({ freq: 620, type: "triangle" }); break;
        case "shift": if (this.player.dash()) this.beeper.beep({ freq: 200, type: "square" }); break;
        case "p": this.togglePause(); break;
        case "r": this.reset(); break;
        case "c": if (this.practice) { this.setCheckpoint(); this.beeper.beep({ freq: 880 }); } break;
        case "v": if (this.practice) { this.clearCheckpoint(); this.beeper.beep({ freq: 330 }); } break;
        case "e": this.setEditorEnabled(!this.editorEnabled); break;
        case "enter": this.start(); break;
        case "1": this.difficultySelect.value = "0.8"; this.speedMultiplier = 0.8; break;
        case "2": this.difficultySelect.value = "1.0"; this.speedMultiplier = 1.0; break;
        case "3": this.difficultySelect.value = "1.2"; this.speedMultiplier = 1.2; break;
        case "4": this.difficultySelect.value = "1.5"; this.speedMultiplier = 1.5; break;
      }
    });
  }

  _editorPlaceAtMouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.baseWidth / rect.width;
    const scaleY = this.baseHeight / (rect.width * (this.baseHeight / this.baseWidth));
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    // Compute world X to place
    const worldX = this.scrollX + this.placeDistance + mx * 0.0; // stick to distance only
    const groundY = this.groundY;
    const grid = 10;
    const snap = (v) => Math.round(v / grid) * grid;

    if (this.tool === "eraser") {
      const pick = this.level.obstacles.findIndex(o => Math.abs(o.x - worldX) < 24 && Math.abs(o.y - groundY + o.height) < 40);
      if (pick >= 0) {
        this.level.obstacles.splice(pick, 1);
        this._saveLevelToStorage();
      }
      return;
    }

    if (this.tool === "block") {
      const w = 40, h = 40;
      const ox = snap(worldX);
      const oy = snap(groundY - h);
      this.level.obstacles.push(new Obstacle(ox, oy, w, h, "block"));
      this._saveLevelToStorage();
      return;
    }

    if (this.tool === "spike") {
      const size = 34;
      const ox = snap(worldX);
      const oy = groundY - size;
      this.level.obstacles.push(new Obstacle(ox, oy, size, size, "spike"));
      this._saveLevelToStorage();
      return;
    }
  }

  setEditorEnabled(flag) {
    this.editorEnabled = !!flag;
    this.editorToggle.checked = this.editorEnabled;
    this.editorPanel.hidden = !this.editorEnabled;
    if (this.editorEnabled) this.paused = true;
  }

  _loadOrGenerateLevel() {
    const saved = localStorage.getItem("dashplus-level");
    if (saved) {
      try {
        this.level = Level.fromJSON(saved);
        this.levelJson.value = this.level.toJSON();
        return;
      } catch (_) {}
    }
    // Generate simple default pattern
    const lvl = new Level();
    const g = this.groundY;
    let x = 600;
    for (let i = 0; i < 14; i++) {
      lvl.obstacles.push(new Obstacle(x, g - 40, 40, 40, "block"));
      if (i % 3 === 2) lvl.obstacles.push(new Obstacle(x + 90, g - 34, 34, 34, "spike"));
      x += 220 + (i % 4) * 30;
    }
    // A small platform section
    const platformY = g - 140;
    for (let i = 0; i < 6; i++) {
      lvl.obstacles.push(new Obstacle(2200 + i * 46, platformY, 44, 20, "block"));
    }
    this.level = lvl;
    this._saveLevelToStorage();
    this.levelJson.value = this.level.toJSON();
  }

  _saveLevelToStorage() {
    try { localStorage.setItem("dashplus-level", this.level.toJSON()); } catch (_) {}
    if (this.levelJson) this.levelJson.value = this.level.toJSON();
  }
  _loadLevelFromStorage() {
    const saved = localStorage.getItem("dashplus-level");
    if (saved) {
      this.level = Level.fromJSON(saved);
      this.levelJson.value = this.level.toJSON();
    }
  }

  start() {
    this.running = true; this.paused = false;
  }
  togglePause() { this.paused = !this.paused; }
  reset() {
    this.scrollX = 0;
    this.player.resetToCheckpoint(this.player.spawnX, this.player.spawnY);
    this.deaths = 0;
    this.checkpoint = null;
    this.running = false; this.paused = false;
  }
  setCheckpoint() {
    this.checkpoint = { x: this.player.x, y: this.player.y, scrollX: this.scrollX };
  }
  clearCheckpoint() { this.checkpoint = null; }

  _update(dt) {
    if (!this.running || this.paused) return;

    // Horizontal auto-scroll via world offset
    const targetSpeed = this.speedBase * this.speedMultiplier;
    this.scrollX += targetSpeed;

    // Player physics (only Y used for motion relative to ground)
    this.player.velocityY += this.gravity;
    this.player.y += this.player.velocityY;
    this.player.velocityX *= this.frictionX; // dash fades

    // Ground collision
    if (this.player.y + this.player.size > this.groundY) {
      this.player.y = this.groundY - this.player.size;
      this.player.velocityY = 0;
      this.player.grounded = true;
      this.player.dashAvailable = true;
    } else {
      this.player.grounded = false;
    }

    // Collisions with obstacles
    const px = this.player.x + this.scrollX; // player's world x
    const py = this.player.y;
    const ps = this.player.size;
    const invulnerable = now() < this.player.invincibleUntil;

    // Only check obstacles near the viewport
    const viewLeft = this.scrollX - 40;
    const viewRight = this.scrollX + this.baseWidth + 100;
    for (const obs of this.level.obstacles) {
      if (obs.right < viewLeft || obs.x > viewRight) continue;
      // Axis-aligned rect collision in world space
      const ox = obs.x, oy = obs.y;
      const ow = obs.width, oh = obs.height;
      const collides = px < ox + ow && px + ps > ox && py < oy + oh && py + ps > oy;
      if (collides && !invulnerable) {
        // Death
        this.deaths++;
        this.beeper.beep({ freq: 120, type: "sawtooth", duration: 0.12 });
        if (this.practice && this.checkpoint) {
          this.scrollX = this.checkpoint.scrollX;
          this.player.resetToCheckpoint(this.checkpoint.x, this.checkpoint.y);
        } else {
          this.scrollX = 0;
          this.player.resetToCheckpoint(this.player.spawnX, this.player.spawnY);
          this.running = false; // stop until restarted
        }
        break;
      }
    }
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.baseWidth, h = this.baseHeight;

    // Clear background gradient
    ctx.clearRect(0, 0, w, h);
    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, this._shade(this.bgColor, 0));
    grd.addColorStop(1, this._shade(this.bgColor, -20));
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    // Parallax layers
    this._drawParallax();

    // Ground line
    ctx.strokeStyle = this._shade(this.bgColor, 20);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, this.groundY + 0.5);
    ctx.lineTo(w, this.groundY + 0.5);
    ctx.stroke();

    // Obstacles (world to screen: x - scrollX)
    for (const o of this.level.obstacles) {
      const sx = o.x - this.scrollX;
      if (sx + o.width < -2 || sx > w + 2) continue;
      if (o.kind === "spike") {
        this._drawSpike(sx, o.y, o.width, o.height, this.obstacleColor);
      } else {
        ctx.fillStyle = this.obstacleColor;
        ctx.fillRect(Math.round(sx), Math.round(o.y), Math.round(o.width), Math.round(o.height));
      }
    }

    // Player
    const px = Math.round(this.player.x);
    const py = Math.round(this.player.y);
    ctx.save();
    ctx.translate(px + this.player.size / 2, py + this.player.size / 2);
    const tilt = clamp(this.player.velocityY, -12, 12) * 0.02;
    ctx.rotate(tilt);
    ctx.fillStyle = this.playerColor;
    const s = this.player.size;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();

    // HUD
    this._drawHUD();
  }

  _drawParallax() {
    const ctx = this.ctx; const w = this.baseWidth; const h = this.baseHeight;
    const sX = this.scrollX;
    const drawLayer = (y, amplitude, step, color, alpha, speedMul) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      const offset = -((sX * speedMul) % step);
      for (let x = offset - step; x < w + step; x += step) {
        const hh = 10 + Math.abs(Math.sin((x + sX) * 0.003)) * amplitude;
        ctx.fillRect(x, y - hh, 8, hh);
      }
      ctx.globalAlpha = 1;
    };
    drawLayer(h - 120, 20, 46, this._shade(this.bgColor, 30), 0.4, 0.25);
    drawLayer(h - 90, 14, 36, this._shade(this.bgColor, 40), 0.5, 0.5);
    drawLayer(h - 60, 10, 26, this._shade(this.bgColor, 60), 0.6, 0.75);
  }

  _drawSpike(x, y, w, h, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  _drawHUD() {
    const ctx = this.ctx; const w = this.baseWidth;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(12, 12, 210, 70);
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    const meters = Math.floor((this.scrollX + this.player.x) / 12);
    ctx.fillText(`Дистанция: ${meters}м`, 20, 34);
    ctx.fillText(`Смерти: ${this.deaths}`, 20, 54);
    ctx.fillText(this.practice ? `Практика: чекпоинт ${this.checkpoint ? "есть" : "нет"}` : "Режим: обычный", 20, 74);

    if (this.editorEnabled) {
      ctx.fillStyle = "rgba(13,110,253,0.18)";
      const lx = Math.round(this.player.x + this.placeDistance - this.scrollX);
      ctx.fillRect(lx - 2, 0, 4, this.baseHeight);
    }
  }

  _shade(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const r = (num >> 16) & 0xff, g = (num >> 8) & 0xff, b = num & 0xff;
    const t = (100 + percent) / 100;
    const nr = clamp(Math.round(r * t), 0, 255);
    const ng = clamp(Math.round(g * t), 0, 255);
    const nb = clamp(Math.round(b * t), 0, 255);
    return `#${((1 << 24) + (nr << 16) + (ng << 8) + nb).toString(16).slice(1)}`;
  }

  _startLoop() {
    let last = now();
    const tick = () => {
      const t = now();
      const dt = clamp((t - last) / 16.6667, 0, 2);
      last = t;
      this._update(dt);
      this._draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _createInputs() {
    return {}; // left for future expansion
  }
}

// ===== Boot =====
window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("gameCanvas");
  const game = new Game(canvas);
  // Expose for debugging in console
  window.__game = game;
});

