import Phaser from 'phaser';

const WIDTH = 960;
const HEIGHT = 540;
const PLAYER_SPEED = 220;
const ENEMY_SPEED = 70;
const ELITE_SPEED = 55;
const PROJECTILE_SPEED = 420;
const FIRE_INTERVAL = 350;
// 멈췄을 때 세상이 흐르는 최소 배율. 0이면 물리 엔진 나눗셈이 터진다.
const IDLE_TIME_SCALE = 0.12;
// 콤보는 실시간으로 식는다 — 시간을 멈춰도 보존되지 않는 게 핵심 규칙.
const COMBO_WINDOW_MS = 2500;
const GAUGE_MAX = 3;
const GAUGE_CHARGE_MS = 1200;
const DASH_DURATION_MS = 160;
const DASH_IFRAME_MS = 350;
const MERGE_MIN_AGE_MS = 2500;
const MAX_ELITES = 4;

type Enemy = Phaser.Types.Physics.Arcade.ImageWithDynamicBody & {
  hp?: number;
  elite?: boolean;
  bornAt?: number;
};

class PrototypeScene extends Phaser.Scene {
  private player!: Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
  private enemies!: Phaser.Physics.Arcade.Group;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
  private dashKey!: Phaser.Input.Keyboard.Key;
  private dim!: Phaser.GameObjects.Rectangle;
  private hud!: Phaser.GameObjects.Text;
  private comboBar!: Phaser.GameObjects.Rectangle;
  private gaugePips: Phaser.GameObjects.Rectangle[] = [];

  private worldSpeed = 1;
  private lastDir = new Phaser.Math.Vector2(0, -1);
  private score = 0;
  private combo = 0;
  private comboTimeLeft = 0;
  private gauge = GAUGE_MAX;
  private dashUntil = 0;
  private invincibleUntil = 0;
  private dead = false;

  create() {
    this.dead = false;
    this.worldSpeed = 1;
    this.score = 0;
    this.combo = 0;
    this.comboTimeLeft = 0;
    this.gauge = GAUGE_MAX;
    this.gaugePips = [];

    const g = this.add.graphics();
    g.fillStyle(0xf2f2f2).fillRect(0, 0, 16, 16).generateTexture('player', 16, 16);
    g.clear().fillStyle(0xe4573d).fillCircle(8, 8, 8).generateTexture('enemy', 16, 16);
    g.clear().fillStyle(0x8c2318).fillCircle(14, 14, 14).generateTexture('elite', 28, 28);
    g.clear().fillStyle(0xffd23f).fillRect(0, 0, 8, 4).generateTexture('projectile', 8, 4);
    g.destroy();

    this.player = this.physics.add.image(WIDTH / 2, HEIGHT / 2, 'player');
    this.player.setCollideWorldBounds(true);

    this.enemies = this.physics.add.group();
    this.projectiles = this.physics.add.group();

    this.time.addEvent({ delay: 800, loop: true, callback: () => this.spawnEnemy() });
    this.time.addEvent({ delay: FIRE_INTERVAL, loop: true, callback: () => this.fire() });

    this.physics.add.overlap(this.player, this.enemies, () => this.onPlayerHit());
    this.physics.add.overlap(this.projectiles, this.enemies, (proj, obj) =>
      this.onProjectileHit(proj as Phaser.GameObjects.GameObject, obj as Enemy),
    );
    // 적끼리 겹치면 합체 — 카이팅으로 뭉치게 몰면 엘리트가 태어난다.
    this.physics.add.overlap(this.enemies, this.enemies, (a, b) =>
      this.tryMerge(a as Enemy, b as Enemy),
    );

    this.dim = this.add
      .rectangle(0, 0, WIDTH, HEIGHT, 0x05060a)
      .setOrigin(0)
      .setAlpha(0)
      .setDepth(10);

    this.hud = this.add.text(12, 10, '', { fontSize: '16px', color: '#e8e8f0' }).setDepth(11);
    this.add
      .text(WIDTH - 12, 10, `최고 ${this.highScore()}`, { fontSize: '16px', color: '#9aa0b0' })
      .setOrigin(1, 0)
      .setDepth(11);
    this.comboBar = this.add
      .rectangle(12, 56, 0, 5, 0xffd23f)
      .setOrigin(0, 0.5)
      .setDepth(11);
    for (let i = 0; i < GAUGE_MAX; i++) {
      this.gaugePips.push(
        this.add
          .rectangle(12 + i * 26, HEIGHT - 18, 22, 8, 0x4fc3f7)
          .setOrigin(0, 0.5)
          .setDepth(11),
      );
    }
    this.add
      .text(WIDTH / 2, HEIGHT - 28, '이동: WASD/방향키 · 대시: 스페이스 — 움직일 때만 시간이 흐른다', {
        fontSize: '15px',
        color: '#9aa0b0',
      })
      .setOrigin(0.5)
      .setDepth(11);

    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.wasd = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.dashKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.R).on('down', () => this.scene.restart());
  }

  update(_time: number, deltaMs: number) {
    if (this.dead) return;
    const now = this.time.now;

    const dir = new Phaser.Math.Vector2(
      Number(this.cursors.right.isDown || this.wasd.right.isDown) -
        Number(this.cursors.left.isDown || this.wasd.left.isDown),
      Number(this.cursors.down.isDown || this.wasd.down.isDown) -
        Number(this.cursors.up.isDown || this.wasd.up.isDown),
    ).normalize();
    if (dir.lengthSq() > 0) this.lastDir.copy(dir);

    const dashing = now < this.dashUntil;
    if (Phaser.Input.Keyboard.JustDown(this.dashKey) && this.gauge >= 1 && !dashing) {
      this.gauge -= 1;
      this.dashUntil = now + DASH_DURATION_MS;
      this.invincibleUntil = now + DASH_IFRAME_MS;
    }

    const moving = dir.lengthSq() > 0 || dashing;
    const target = moving ? 1 : IDLE_TIME_SCALE;
    const lerp = 1 - Math.exp(-10 * (deltaMs / 1000));
    this.worldSpeed = Phaser.Math.Linear(this.worldSpeed, target, lerp);

    // Arcade 물리는 timeScale이 클수록 느려지고, Clock은 작을수록 느려진다 — 서로 반대.
    this.physics.world.timeScale = 1 / this.worldSpeed;
    this.time.timeScale = this.worldSpeed;

    // 플레이어는 실시간 속도 유지: 물리 감속을 역보정해서 SUPERHOT 감각을 만든다.
    const speed = (dashing ? PLAYER_SPEED * 3.2 : PLAYER_SPEED) / this.worldSpeed;
    const move = dashing && dir.lengthSq() === 0 ? this.lastDir : dir;
    this.player.setVelocity(move.x * speed, move.y * speed);
    this.player.setAlpha(now < this.invincibleUntil ? 0.4 : 1);

    // 콤보·게이지는 실시간 진행 — 시간 흐름과 무관한 것이 이 게임의 저울이다.
    if (this.combo > 0) {
      this.comboTimeLeft -= deltaMs;
      if (this.comboTimeLeft <= 0) this.combo = 0;
    }
    if (this.worldSpeed < 0.35 && this.gauge < GAUGE_MAX) {
      this.gauge = Math.min(GAUGE_MAX, this.gauge + deltaMs / GAUGE_CHARGE_MS);
    }

    this.enemies.getChildren().forEach((obj) => {
      const enemy = obj as Enemy;
      const aim = new Phaser.Math.Vector2(this.player.x - enemy.x, this.player.y - enemy.y)
        .normalize()
        .scale(enemy.elite ? ELITE_SPEED : ENEMY_SPEED);
      enemy.setVelocity(aim.x, aim.y);
    });

    this.projectiles.getChildren().forEach((obj) => {
      const p = obj as Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
      if (p.x < -30 || p.x > WIDTH + 30 || p.y < -30 || p.y > HEIGHT + 30) p.destroy();
    });

    this.dim.setAlpha((1 - this.worldSpeed) * 0.45);
    this.hud.setText(
      `점수 ${this.score}` + (this.combo > 0 ? `   콤보 x${(1 + this.combo * 0.1).toFixed(1)}` : ''),
    );
    this.comboBar.width = this.combo > 0 ? 120 * (this.comboTimeLeft / COMBO_WINDOW_MS) : 0;
    this.gaugePips.forEach((pip, i) => {
      const fill = Phaser.Math.Clamp(this.gauge - i, 0, 1);
      pip.setAlpha(0.25 + 0.75 * fill);
      pip.width = Math.max(2, 22 * fill);
    });
  }

  private fire() {
    if (this.dead) return;
    let nearest: Enemy | null = null;
    let best = Infinity;
    this.enemies.getChildren().forEach((obj) => {
      const e = obj as Enemy;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, e.x, e.y);
      if (d < best) {
        best = d;
        nearest = e;
      }
    });
    if (!nearest) return;
    const target = nearest as Enemy;
    const p = this.physics.add.image(this.player.x, this.player.y, 'projectile');
    this.projectiles.add(p);
    const aim = new Phaser.Math.Vector2(target.x - this.player.x, target.y - this.player.y)
      .normalize()
      .scale(PROJECTILE_SPEED);
    p.setVelocity(aim.x, aim.y);
    p.setRotation(aim.angle());
  }

  private onProjectileHit(proj: Phaser.GameObjects.GameObject, enemy: Enemy) {
    proj.destroy();
    enemy.hp = (enemy.hp ?? 1) - 1;
    if (enemy.hp > 0) return;
    const gain = enemy.elite ? 50 : 10;
    this.combo += 1;
    this.comboTimeLeft = COMBO_WINDOW_MS;
    this.score += Math.round(gain * (1 + this.combo * 0.1));
    enemy.destroy();
  }

  private tryMerge(a: Enemy, b: Enemy) {
    if (a === b || !a.active || !b.active || a.elite || b.elite) return;
    const now = this.time.now;
    if (now - (a.bornAt ?? 0) < MERGE_MIN_AGE_MS || now - (b.bornAt ?? 0) < MERGE_MIN_AGE_MS) return;
    const elites = this.enemies.getChildren().filter((e) => (e as Enemy).elite).length;
    if (elites >= MAX_ELITES) return;
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    a.destroy();
    b.destroy();
    const elite = this.physics.add.image(x, y, 'elite') as Enemy;
    elite.hp = 4;
    elite.elite = true;
    elite.bornAt = now;
    this.enemies.add(elite);
  }

  private onPlayerHit() {
    if (this.dead || this.time.now < this.invincibleUntil) return;
    this.dead = true;
    this.physics.pause();
    const high = Math.max(this.score, this.highScore());
    localStorage.setItem('highScore', String(high));
    this.add
      .rectangle(0, 0, WIDTH, HEIGHT, 0x05060a, 0.7)
      .setOrigin(0)
      .setDepth(20);
    this.add
      .text(WIDTH / 2, HEIGHT / 2 - 20, `점수 ${this.score}   최고 ${high}`, {
        fontSize: '28px',
        color: '#e8e8f0',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(WIDTH / 2, HEIGHT / 2 + 24, 'R 또는 스페이스 — 즉시 재시작', {
        fontSize: '18px',
        color: '#ffd23f',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.input.keyboard!.once('keydown-SPACE', () => this.scene.restart());
  }

  private spawnEnemy() {
    if (this.dead) return;
    const edge = Phaser.Math.Between(0, 3);
    const x = edge === 0 ? -20 : edge === 1 ? WIDTH + 20 : Phaser.Math.Between(0, WIDTH);
    const y = edge === 2 ? -20 : edge === 3 ? HEIGHT + 20 : Phaser.Math.Between(0, HEIGHT);
    const enemy = this.physics.add.image(x, y, 'enemy') as Enemy;
    enemy.hp = 1;
    enemy.bornAt = this.time.now;
    this.enemies.add(enemy);
  }

  private highScore(): number {
    return Number(localStorage.getItem('highScore') ?? 0);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: '#14161d',
  pixelArt: true,
  physics: { default: 'arcade' },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: PrototypeScene,
});
