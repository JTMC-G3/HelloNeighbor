import * as THREE from 'three';

const STAND_H = 1.7;
const CROUCH_H = 1.05;
const STAND_EYE = 1.6;
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
  }

  get pos() {
    return this.ch.pos;
  }

  eye(out = new THREE.Vector3()) {
    return out.set(this.ch.pos.x, this.ch.pos.y + this.eyeH, this.ch.pos.z);
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
    this.ch.height = STAND_H;
    this.eyeH = STAND_EYE;
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

    const wantCrouch = k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight');
    if (wantCrouch) this.crouching = true;
    else if (this.crouching && !this.physics.blockedAbove(this.ch, STAND_H)) this.crouching = false;
    this.ch.height = this.crouching ? CROUCH_H : STAND_H;
    const targetEye = this.crouching ? CROUCH_EYE : STAND_EYE;
    this.eyeH += (targetEye - this.eyeH) * Math.min(1, dt * 12);

    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const s = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * f + cos * s;
    let wz = -cos * f - sin * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) {
      wx /= wl;
      wz /= wl;
    }
    this.sprinting = (k.has('ShiftLeft') || k.has('ShiftRight')) && f > 0 && !this.crouching;
    const speed = this.crouching ? 1.9 : this.sprinting ? 6.2 : 3.7;
    const accel = this.ch.onGround ? 14 : 3;
    const blend = Math.min(1, accel * dt);
    this.ch.vel.x += (wx * speed - this.ch.vel.x) * blend;
    this.ch.vel.z += (wz * speed - this.ch.vel.z) * blend;

    if (k.has('Space') && this.ch.onGround && !this.crouching) {
      this.ch.vel.y = 5.0;
      this.ch.onGround = false;
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
        const r = this.crouching ? 0 : this.sprinting ? 11 : 4.5;
        if (r > 0) emitNoise(this.ch.pos, r);
      }
    }

    this.syncCamera(dt);
  }

  syncCamera(dt) {
    const target = this.ch.pos.y + this.eyeH;
    if (dt === 0 || Math.abs(target - this.camY) > 0.8) this.camY = target;
    else this.camY += (target - this.camY) * Math.min(1, dt * 18);
    const bobAmt = this.moving && this.ch.onGround ? (this.sprinting ? 0.05 : 0.03) : 0;
    const by = Math.sin(this.bob * 2) * bobAmt;
    this.camera.position.set(this.ch.pos.x, this.camY + by, this.ch.pos.z).add(this.camOffset);
    this.camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
  }
}
