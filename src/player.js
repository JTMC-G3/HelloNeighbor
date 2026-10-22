import * as THREE from 'three';

const STAND_H = 1.7;
const CROUCH_H = 1.05;
const STAND_EYE = 1.6;
// Source-style air strafing (see Player.update): the per-tick speed cap along your steering,
// how hard you accelerate towards it, and a safety limit on bunny-hop speed (m/s).
const AIR_CAP = 0.6;
const AIR_ACCEL = 10;
const MAX_HOP_SPEED = 30;
const BACKHOP_BOOST = 1.14; // speed multiplier per crouched hop while facing against your momentum
const CROUCH_EYE = 0.95;

export class Player {
  constructor(camera, physics, sound) {
    this.camera = camera;
    this.physics = physics;
    this.sound = sound;
    this.ch = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      radius: 0.3,
      height: STAND_H,
      stepHeight: 0.45,
      onGround: true,
    };
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.sensitivity = 0.0022;
    this.crouching = false;
    this.sprinting = false;
    this.eyeH = STAND_EYE;
    this.camY = 0;
    this.stepAcc = 0;
    this.bob = 0;
    this.held = null;
    this.hidden = null; // hide spot (wardrobe) while hiding
    // Extra camera motion for cutscenes (getting grabbed, climbing into wardrobes).
    this.camOffset = new THREE.Vector3();
    this.roll = 0;
    this.moving = false;
    this.vr = null; // VR controller (vr.js) while in a headset
    this.body = { standH: STAND_H, standEye: STAND_EYE, walk: 3.7, sprint: 6.2, canCrouch: true };
  }

  /** Change size and speed (multiplayer: playing as the neighbor). */
  setBody(opts) {
    Object.assign(this.body, opts);
    if (opts.radius) this.ch.radius = opts.radius;
    this.ch.height = this.body.standH;
    this.eyeH = this.body.standEye;
  }

  /**
   * VR: how much to raise the play space above your real height. A kid's body
   * matches a grown-up's real height closely enough (0), but playing the
   * (taller) neighbor lifts you a little so you look down on the kids.
   */
  get vrLift() {
    return this.body.standEye - STAND_EYE;
  }

  get pos() {
    return this.ch.pos;
  }

  eye(out = new THREE.Vector3()) {
    // In VR your eyes are wherever your head actually is (duck for real to hide!).
    if (this.vr) return this.vr.headWorld(out);
    return out.set(this.ch.pos.x, this.ch.pos.y + this.eyeH, this.ch.pos.z);
  }

  /** Where you're looking: { yaw, pitch } (in VR, where your head is really pointed). */
  facing() {
    return this.vr ? this.vr.look() : { yaw: this.yaw, pitch: this.pitch };
  }

  forward(out = new THREE.Vector3()) {
    return this.camera.getWorldDirection(out);
  }

  spawn(p, yaw = 0) {
    this.ch.pos.copy(p);
    this.ch.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.camY = p.y + this.eyeH;
    this.crouching = false;
    this.ch.height = this.body.standH;
    this.eyeH = this.body.standEye;
    this.camOffset.set(0, 0, 0);
    this.roll = 0;
    this.syncCamera(0);
  }

  look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5, 1.5);
  }

  update(dt, emitNoise) {
    const k = this.keys;
    // Keyboard look (for trackpads / when pointer lock is unavailable).
    const lookSpeed = 2.2 * dt;
    if (k.has('ArrowLeft')) this.yaw += lookSpeed;
    if (k.has('ArrowRight')) this.yaw -= lookSpeed;
    if (k.has('ArrowUp')) this.pitch = Math.min(1.5, this.pitch + lookSpeed);
    if (k.has('ArrowDown')) this.pitch = Math.max(-1.5, this.pitch - lookSpeed);

    const vi = this.vr ? this.vr.input : null;
    const b = this.body;
    const wantCrouch = b.canCrouch && (vi ? vi.crouch || this.vr.headHeight() < 1.15 : k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight'));
    if (wantCrouch) this.crouching = true;
    else if (this.crouching && !this.physics.blockedAbove(this.ch, b.standH)) this.crouching = false;
    this.ch.height = this.crouching ? CROUCH_H : b.standH;
    const targetEye = this.crouching ? CROUCH_EYE : b.standEye;
    this.eyeH += (targetEye - this.eyeH) * Math.min(1, dt * 12);

    // Thumbstick in VR (partial tilt = slower), keys on desktop.
    const f = vi ? -vi.moveY : (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const s = vi ? vi.moveX : (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const moveYaw = vi ? this.vr.headYaw() : this.yaw;
    const sin = Math.sin(moveYaw);
    const cos = Math.cos(moveYaw);
    let wx = -sin * f + cos * s;
    let wz = -cos * f - sin * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    this.sprinting = (vi ? vi.sprint && wl > 0.3 : (k.has('ShiftLeft') || k.has('ShiftRight')) && f > 0) && !this.crouching;
    const speed = this.crouching ? 1.9 : this.sprinting ? b.sprint : b.walk;
    const wantJump = vi ? vi.jump : k.has('Space');
    // Source-engine style movement on desktop: hold jump and you bunny-hop (no friction on the
    // landing frame, so speed is kept), and in the air you accelerate along wherever you steer
    // with a low speed cap per tick, so strafing (A/D while turning the mouse the same way) builds speed.
    const source = !vi;
    if (wantJump && this.ch.onGround && (!this.crouching || source)) {
      if (vi) vi.jump = false;
      this.ch.vel.y = 5.0;
      this.ch.onGround = false;
      // Accelerated back-hopping: crouched, facing away from where you're heading, every
      // hop adds a big chunk of speed (turn round mid-air, crouch, and keep jumping).
      const hs = Math.hypot(this.ch.vel.x, this.ch.vel.z);
      if (source && this.crouching && hs > 1.5) {
        const facing = (-sin * this.ch.vel.x - cos * this.ch.vel.z) / hs;
        if (facing < -0.35) {
          const boost = Math.min(MAX_HOP_SPEED, hs * BACKHOP_BOOST + 0.4) / hs;
          this.ch.vel.x *= boost;
          this.ch.vel.z *= boost;
        }
      }
      // Hopping fast is loud: he hears every landing-and-leaving thump.
      if (source && Math.hypot(this.ch.vel.x, this.ch.vel.z) > b.sprint * 1.15) emitNoise(this.ch.pos, 5);
    }
    if (source && !this.ch.onGround) {
      if (wl > 0.01) {
        const wishSpeed = speed * Math.min(1, wl);
        const dx = wx / wl;
        const dz = wz / wl;
        const add = AIR_CAP - (this.ch.vel.x * dx + this.ch.vel.z * dz);
        if (add > 0) {
          const gain = Math.min(add, AIR_ACCEL * wishSpeed * dt);
          this.ch.vel.x += dx * gain;
          this.ch.vel.z += dz * gain;
        }
      }
      const h = Math.hypot(this.ch.vel.x, this.ch.vel.z);
      if (h > MAX_HOP_SPEED) {
        this.ch.vel.x *= MAX_HOP_SPEED / h;
        this.ch.vel.z *= MAX_HOP_SPEED / h;
      }
    } else {
      const accel = this.ch.onGround ? 14 : 3;
      const blend = Math.min(1, accel * dt);
      this.ch.vel.x += (wx * speed - this.ch.vel.x) * blend;
      this.ch.vel.z += (wz * speed - this.ch.vel.z) * blend;
    }

    this.physics.moveCharacter(this.ch, dt);

    if (this.ch.landingSpeed > 5) {
      this.sound.land(this.ch.landingSpeed);
      emitNoise(this.ch.pos, Math.min(12, this.ch.landingSpeed));
    }

    const hSpeed = Math.hypot(this.ch.vel.x, this.ch.vel.z);
    this.moving = hSpeed > 0.5;
    if (this.ch.onGround && this.moving) {
      this.stepAcc += hSpeed * dt;
      this.bob += hSpeed * dt * 2.2;
      const stride = this.sprinting ? 2.1 : this.crouching ? 1.3 : 1.7;
      if (this.stepAcc > stride) {
        this.stepAcc = 0;
        const indoors = this.ch.pos.y > 0.2 || this.ch.pos.y < -0.5;
        if (!this.crouching) this.sound.footstep(indoors, this.sprinting);
        // Only running carries far enough for him to hear, and only just.
        if (this.sprinting) emitNoise(this.ch.pos, 4.5);
      }
    }

    this.syncCamera(dt);
  }

  syncCamera(dt) {
    if (this.vr) {
      // The headset drives the camera; we just move the play space around.
      this.vr.placeRig();
      return;
    }
    const target = this.ch.pos.y + this.eyeH;
    if (dt === 0 || Math.abs(target - this.camY) > 0.8) this.camY = target;
    else this.camY += (target - this.camY) * Math.min(1, dt * 18);
    const bobAmt = this.moving && this.ch.onGround ? (this.sprinting ? 0.05 : 0.03) : 0;
    const by = Math.sin(this.bob * 2) * bobAmt;
    this.camera.position.set(this.ch.pos.x, this.camY + by, this.ch.pos.z).add(this.camOffset);
    this.camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
  }
}
