import Phaser from 'phaser';

const WIDTH = 960;
const HEIGHT = 540;
const PLAYER_SPEED = 220;
const ELITE_SPEED = 75;
const PROJECTILE_SPEED = 380;
// 예측자: 플레이어 실속도 × 리드 시간 지점을 조준 — 경로 탐색 없이 "앞을 막는" 체감.
const INTERCEPT_LEAD_SEC = 0.6;
// 돌진자: 사거리 안에서 경고 점멸 후 직선 돌진. 경고가 공정성을 만든다.
const CHARGER_RANGE = 250;
const CHARGER_WINDUP_MS = 650;
const CHARGER_CHARGE_MS = 700;
const CHARGER_CHARGE_SPEED = 330;
// 시작은 약하게 — 초반은 도망과 수집이 본업, 성장이 재미를 견인한다.
const START_FIRE_INTERVAL = 900;
const START_MAGNET_RADIUS = 60;
const COLLECT_RADIUS = 20;
const GEM_PULL_SPEED = 340;
const MAX_GEMS = 200;
// 불릿타임 중 세상 배율. 0이면 물리 엔진 나눗셈이 터진다.
const BULLET_TIME_SCALE = 0.2;
// 불릿타임 유지 비용: 게이지 1칸이 버티는 시간.
const BULLET_DRAIN_MS = 1500;
// 콤보는 실시간으로 식는다 — 시간을 멈춰도 보존되지 않는 게 핵심 규칙.
const COMBO_WINDOW_MS = 2500;
const GAUGE_MAX = 3;
const GAUGE_CHARGE_MS = 1200;
const DASH_DURATION_MS = 160;
const DASH_IFRAME_MS = 350;
const MERGE_MIN_AGE_MS = 2500;
const MAX_ELITES = 4;
// 난이도 디렉터 (ADR 참고: VS 쿼터 + sqrt 곡선 + L4D 피크·밸리)
const DIRECTOR_TICK_MS = 250;
const BASE_MIN_DENSITY = 12;
const DENSITY_GROWTH_SEC = 10; // N초마다 최소 밀도 +1
const PULSE_INTERVAL_MS = 45_000;
const VALLEY_MS = 10_000;
const SPEED_GROWTH = 0.002; // 초당 적 속도 증가율 (선형, 상한 1.6배)

type EnemyKind = 'chaser' | 'inter' | 'tank' | 'charger';

const KIND_STATS: Record<
  EnemyKind,
  { tex: string; hp: number; speed: number; score: number; gems: number }
> = {
  chaser: { tex: 'enemy', hp: 1, speed: 95, score: 10, gems: 1 },
  inter: { tex: 'inter', hp: 1, speed: 105, score: 15, gems: 1 },
  tank: { tex: 'tank', hp: 3, speed: 55, score: 20, gems: 2 },
  charger: { tex: 'charger', hp: 2, speed: 80, score: 20, gems: 2 },
};

type Enemy = Phaser.Types.Physics.Arcade.ImageWithDynamicBody & {
  hp?: number;
  elite?: boolean;
  bornAt?: number;
  kind?: EnemyKind;
  mode?: 'seek' | 'windup' | 'charge';
  modeUntil?: number;
  chargeDir?: Phaser.Math.Vector2;
};

type UpgradeDef = {
  key: string;
  name: string;
  blurb: string; // 이 스탯이 무엇인지 평문 설명
  max?: number;
  apply: (s: PrototypeScene) => void;
  info: (s: PrototypeScene) => string; // 지금 → 다음 수치 미리보기
};

const UPGRADE_DEFS: UpgradeDef[] = [
  {
    key: 'rate',
    name: '공속',
    blurb: '자동 공격이 더 자주 나간다.',
    apply: (s) => (s.fireInterval *= 0.85),
    info: (s) => `발사 간격 ${(s.fireInterval / 1000).toFixed(2)}초 → ${((s.fireInterval * 0.85) / 1000).toFixed(2)}초`,
  },
  {
    key: 'multi',
    name: '갈래',
    blurb: '투사체가 부채꼴로 한 발 더 나간다.',
    max: 3,
    apply: (s) => (s.projectileCount += 1),
    info: (s) => `한 번에 ${s.projectileCount}발 → ${s.projectileCount + 1}발`,
  },
  {
    key: 'dmg',
    name: '피해',
    blurb: '투사체 한 발의 위력이 커진다. 엘리트를 빨리 뚫는 열쇠.',
    apply: (s) => (s.damage += 1),
    info: (s) => `피해 ${s.damage} → ${s.damage + 1}`,
  },
  {
    key: 'speed',
    name: '신속',
    blurb: '이동 속도가 빨라진다. 대시 거리도 함께 늘어난다.',
    max: 5,
    apply: (s) => (s.moveSpeed *= 1.1),
    info: (s) => `이동 속도 ${Math.round(s.moveSpeed)} → ${Math.round(s.moveSpeed * 1.1)}`,
  },
  {
    key: 'gauge',
    name: '집중',
    blurb: '멈춰 서 있으면 차오르는 파란 게이지 — 대시(스페이스)와 불릿타임(Shift)의 연료.',
    max: 3,
    apply: (s) => (s.gaugeMax += 1),
    info: (s) => `게이지 최대 ${s.gaugeMax}칸 → ${s.gaugeMax + 1}칸`,
  },
  {
    key: 'magnet',
    name: '자석',
    blurb: 'XP 보석을 끌어당기는 반경이 넓어진다.',
    apply: (s) => (s.magnetRadius *= 1.4),
    info: (s) => `수집 반경 ${Math.round(s.magnetRadius)} → ${Math.round(s.magnetRadius * 1.4)}`,
  },
];

class PrototypeScene extends Phaser.Scene {
  private player!: Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
  private enemies!: Phaser.Physics.Arcade.Group;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
  private dashKey!: Phaser.Input.Keyboard.Key;
  private bulletKey!: Phaser.Input.Keyboard.Key;
  private pauseOverlay!: Phaser.GameObjects.Container;
  private paused = false;
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
  private runStart = 0;
  private lastExtraSpawn = 0;
  private nextPulseAt = 0;
  private valleyUntil = 0;

  // 성장 스탯 — 업그레이드가 만진다 (UPGRADE_DEFS에서 접근하므로 public).
  fireInterval = START_FIRE_INTERVAL;
  projectileCount = 1;
  damage = 1;
  moveSpeed = PLAYER_SPEED;
  gaugeMax = GAUGE_MAX;
  magnetRadius = START_MAGNET_RADIUS;

  private fireCooldown = 0;
  private level = 1;
  private xp = 0;
  private gems: Phaser.GameObjects.Image[] = [];
  private stacks: Record<string, number> = {};
  private choosing = false;
  private xpBar!: Phaser.GameObjects.Rectangle;
  private levelUpUI?: Phaser.GameObjects.Container;
  private levelKeys: Phaser.Input.Keyboard.Key[] = [];

  create() {
    this.dead = false;
    this.paused = false;
    this.choosing = false;
    // 일시정지·레벨업 도중 R 재시작 시 정지 상태가 새 런을 오염시키지 않게 명시 해제.
    this.time.paused = false;
    this.physics.resume();
    this.levelKeys = [];
    this.worldSpeed = 1;
    this.score = 0;
    this.combo = 0;
    this.comboTimeLeft = 0;
    this.fireInterval = START_FIRE_INTERVAL;
    this.projectileCount = 1;
    this.damage = 1;
    this.moveSpeed = PLAYER_SPEED;
    this.gaugeMax = GAUGE_MAX;
    this.magnetRadius = START_MAGNET_RADIUS;
    this.fireCooldown = this.fireInterval;
    this.level = 1;
    this.xp = 0;
    this.gems = [];
    this.stacks = {};
    this.gauge = this.gaugeMax;
    this.gaugePips = [];

    const g = this.add.graphics();
    g.fillStyle(0xf2f2f2).fillRect(0, 0, 16, 16).generateTexture('player', 16, 16);
    g.clear().fillStyle(0xe4573d).fillCircle(8, 8, 8).generateTexture('enemy', 16, 16);
    g.clear().fillStyle(0xf5a623).fillTriangle(8, 0, 16, 16, 0, 16).generateTexture('inter', 16, 16);
    g.clear().fillStyle(0x7a3b2e).fillCircle(11, 11, 11).generateTexture('tank', 22, 22);
    g.clear().fillStyle(0x9b59b6).fillRect(0, 0, 16, 16).generateTexture('charger', 16, 16);
    g.clear().fillStyle(0x8c2318).fillCircle(14, 14, 14).generateTexture('elite', 28, 28);
    g.clear().fillStyle(0xffd23f).fillRect(0, 0, 8, 4).generateTexture('projectile', 8, 4);
    g.clear().fillStyle(0x5be07a).fillRect(2, 0, 4, 8).fillRect(0, 2, 8, 4).generateTexture('gem', 8, 8);
    g.destroy();

    this.player = this.physics.add.image(WIDTH / 2, HEIGHT / 2, 'player');
    this.player.setCollideWorldBounds(true);

    this.enemies = this.physics.add.group();
    this.projectiles = this.physics.add.group();

    this.runStart = this.time.now;
    this.lastExtraSpawn = this.runStart;
    this.nextPulseAt = this.runStart + PULSE_INTERVAL_MS;
    this.valleyUntil = 0;
    this.time.addEvent({ delay: DIRECTOR_TICK_MS, loop: true, callback: () => this.directorTick() });

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
    this.xpBar = this.add
      .rectangle(12, 66, 0, 5, 0x5be07a)
      .setOrigin(0, 0.5)
      .setDepth(11);
    this.buildGaugePips();
    this.add
      .text(
        WIDTH / 2,
        HEIGHT - 28,
        '이동 WASD · 대시 스페이스 · 불릿타임 Shift 홀드 · 일시정지 ESC — 멈춰 서면 집중이 차오른다',
        { fontSize: '15px', color: '#9aa0b0' },
      )
      .setOrigin(0.5)
      .setDepth(11);

    this.pauseOverlay = this.add
      .container(0, 0, [
        this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x05060a, 0.7).setOrigin(0),
        this.add
          .text(WIDTH / 2, HEIGHT / 2, '일시정지\nESC — 재개', {
            fontSize: '28px',
            color: '#e8e8f0',
            align: 'center',
          })
          .setOrigin(0.5),
      ])
      .setDepth(30)
      .setVisible(false);

    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.wasd = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.dashKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.bulletKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.R).on('down', () => this.scene.restart());
    kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC).on('down', () => this.togglePause());

    // 첫 런 한정 도구 가이드 — 재시작 루프를 방해하지 않게 registry로 1회만.
    if (!this.registry.get('guideSeen')) {
      this.registry.set('guideSeen', true);
      const guide = this.add
        .container(0, 0, [
          this.add.rectangle(WIDTH / 2, 170, 560, 130, 0x05060a, 0.82).setStrokeStyle(1, 0x4fc3f7),
          this.add
            .text(
              WIDTH / 2,
              170,
              '스페이스 — 대시: 무적으로 적 벽을 뚫는다\nShift 홀드 — 불릿타임: 세상만 느려지고 나는 그대로\n멈춰 서면 파란 집중 게이지가 차오른다 (둘의 연료)',
              { fontSize: '17px', color: '#e8e8f0', align: 'center', lineSpacing: 10 },
            )
            .setOrigin(0.5),
        ])
        .setDepth(25);
      this.tweens.add({
        targets: guide,
        alpha: 0,
        delay: 5000,
        duration: 700,
        onComplete: () => guide.destroy(),
      });
    }
  }

  private togglePause() {
    if (this.dead || this.choosing) return;
    this.paused = !this.paused;
    this.pauseOverlay.setVisible(this.paused);
    if (this.paused) {
      this.physics.pause();
      this.time.paused = true;
    } else {
      this.physics.resume();
      this.time.paused = false;
    }
  }

  private gaugeLabel?: Phaser.GameObjects.Text;

  private buildGaugePips() {
    this.gaugePips.forEach((p) => p.destroy());
    this.gaugePips = [];
    for (let i = 0; i < this.gaugeMax; i++) {
      this.gaugePips.push(
        this.add
          .rectangle(12 + i * 26, HEIGHT - 18, 22, 8, 0x4fc3f7)
          .setOrigin(0, 0.5)
          .setDepth(11),
      );
    }
    this.gaugeLabel?.destroy();
    this.gaugeLabel = this.add
      .text(12 + this.gaugeMax * 26 + 6, HEIGHT - 18, '집중 — 스페이스 대시 · Shift 불릿타임', {
        fontSize: '12px',
        color: '#9aa0b0',
      })
      .setOrigin(0, 0.5)
      .setDepth(11);
  }

  update(_time: number, deltaMs: number) {
    if (this.dead || this.paused || this.choosing) return;
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
      this.cameras.main.shake(90, 0.004);
    }
    // 대시 잔상 — "발동했다"를 몸으로 보여준다.
    if (dashing) {
      const ghost = this.add
        .image(this.player.x, this.player.y, 'player')
        .setAlpha(0.35)
        .setDepth(this.player.depth - 1);
      this.tweens.add({ targets: ghost, alpha: 0, duration: 250, onComplete: () => ghost.destroy() });
    }

    // 세상은 항상 정상 속도. 슬로우모는 Shift 홀드로 게이지를 태울 때만 (ADR-0003).
    const bulletActive = this.bulletKey.isDown && this.gauge > 0;
    if (bulletActive) this.gauge = Math.max(0, this.gauge - deltaMs / BULLET_DRAIN_MS);
    const target = bulletActive ? BULLET_TIME_SCALE : 1;
    const lerp = 1 - Math.exp(-10 * (deltaMs / 1000));
    this.worldSpeed = Phaser.Math.Linear(this.worldSpeed, target, lerp);

    // Arcade 물리는 timeScale이 클수록 느려지고, Clock은 작을수록 느려진다 — 서로 반대.
    this.physics.world.timeScale = 1 / this.worldSpeed;
    this.time.timeScale = this.worldSpeed;

    // 플레이어는 실시간 속도 유지: 물리 감속을 역보정해서 슬로우모 속 우위를 만든다.
    const speed = (dashing ? this.moveSpeed * 3.2 : this.moveSpeed) / this.worldSpeed;
    const move = dashing && dir.lengthSq() === 0 ? this.lastDir : dir;
    this.player.setVelocity(move.x * speed, move.y * speed);
    this.player.setAlpha(now < this.invincibleUntil ? 0.4 : 1);

    // 자동공격은 게임 시간으로 진행 — 불릿타임 중엔 발사도 느려진다.
    this.fireCooldown -= deltaMs * this.worldSpeed;
    while (this.fireCooldown <= 0) {
      this.fire();
      this.fireCooldown += this.fireInterval;
    }

    // XP 보석: 자석 반경 안이면 끌려오고, 닿으면 수집.
    const px = this.player.x;
    const py = this.player.y;
    this.gems = this.gems.filter((gem) => {
      const d = Phaser.Math.Distance.Between(px, py, gem.x, gem.y);
      if (d < COLLECT_RADIUS) {
        gem.destroy();
        this.gainXp(1);
        return false;
      }
      if (d < this.magnetRadius) {
        const step = (GEM_PULL_SPEED * deltaMs) / 1000;
        gem.x += ((px - gem.x) / d) * step;
        gem.y += ((py - gem.y) / d) * step;
      }
      return true;
    });

    // 콤보는 실시간으로 식는다 — 불릿타임으로도 보존 불가.
    if (this.combo > 0) {
      this.comboTimeLeft -= deltaMs;
      if (this.comboTimeLeft <= 0) this.combo = 0;
    }
    // 충전은 완전히 멈춰 서 있을 때만 — 세상이 정상 속도로 다가오는 동안의 투자다.
    const standing = dir.lengthSq() === 0 && !dashing && !bulletActive;
    if (standing && this.gauge < this.gaugeMax) {
      this.gauge = Math.min(this.gaugeMax, this.gauge + deltaMs / GAUGE_CHARGE_MS);
    }

    const speedMul = Math.min(1.6, 1 + this.elapsedSec() * SPEED_GROWTH);
    // 플레이어 실제 화면 속도 (물리 역보정 되돌림) — 예측자 리드 조준용.
    const realVelX = this.player.body.velocity.x * this.worldSpeed;
    const realVelY = this.player.body.velocity.y * this.worldSpeed;
    this.enemies.getChildren().forEach((obj) => {
      const enemy = obj as Enemy;
      const seek = (tx: number, ty: number, spd: number) => {
        const aim = new Phaser.Math.Vector2(tx - enemy.x, ty - enemy.y).normalize().scale(spd);
        enemy.setVelocity(aim.x, aim.y);
      };
      if (enemy.elite) {
        seek(this.player.x, this.player.y, ELITE_SPEED * speedMul);
        return;
      }
      const stats = KIND_STATS[enemy.kind ?? 'chaser'];
      const spd = stats.speed * speedMul;
      switch (enemy.kind) {
        case 'inter':
          seek(
            this.player.x + realVelX * INTERCEPT_LEAD_SEC,
            this.player.y + realVelY * INTERCEPT_LEAD_SEC,
            spd,
          );
          break;
        case 'charger': {
          if (enemy.mode === 'windup') {
            enemy.setVelocity(0, 0);
            enemy.setAlpha(0.4 + 0.6 * Math.abs(Math.sin(now / 60)));
            if (now >= (enemy.modeUntil ?? 0)) {
              enemy.mode = 'charge';
              enemy.modeUntil = now + CHARGER_CHARGE_MS;
              enemy.chargeDir = new Phaser.Math.Vector2(
                this.player.x - enemy.x,
                this.player.y - enemy.y,
              ).normalize();
              enemy.setAlpha(1);
            }
          } else if (enemy.mode === 'charge') {
            const d = enemy.chargeDir!;
            enemy.setVelocity(
              d.x * CHARGER_CHARGE_SPEED * speedMul,
              d.y * CHARGER_CHARGE_SPEED * speedMul,
            );
            if (now >= (enemy.modeUntil ?? 0)) enemy.mode = 'seek';
          } else {
            seek(this.player.x, this.player.y, spd);
            const dist = Phaser.Math.Distance.Between(enemy.x, enemy.y, this.player.x, this.player.y);
            if (dist < CHARGER_RANGE) {
              enemy.mode = 'windup';
              enemy.modeUntil = now + CHARGER_WINDUP_MS;
            }
          }
          break;
        }
        default:
          seek(this.player.x, this.player.y, spd);
      }
    });

    this.projectiles.getChildren().forEach((obj) => {
      const p = obj as Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
      if (p.x < -30 || p.x > WIDTH + 30 || p.y < -30 || p.y > HEIGHT + 30) p.destroy();
    });

    // 불릿타임 연출: 어두워짐 + 플레이어 청색 발광 + 살짝 줌 — "내 시간"임을 보여준다.
    this.dim.setAlpha((1 - this.worldSpeed) * 0.45);
    this.cameras.main.setZoom(1 + (1 - this.worldSpeed) * 0.06);
    if (bulletActive) this.player.setTint(0x7fd8ff);
    else this.player.clearTint();
    const t = Math.floor(this.elapsedSec());
    const clock = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    this.hud.setText(
      `${clock}   Lv${this.level}   점수 ${this.score}` +
        (this.combo > 0 ? `   콤보 x${(1 + this.combo * 0.1).toFixed(1)}` : ''),
    );
    this.xpBar.width = 150 * Phaser.Math.Clamp(this.xp / this.xpNeed(), 0, 1);
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
    const baseAngle = Phaser.Math.Angle.Between(this.player.x, this.player.y, target.x, target.y);
    // 갈래: 투사체를 8도 간격 부채꼴로.
    const spread = Phaser.Math.DegToRad(8);
    for (let i = 0; i < this.projectileCount; i++) {
      const angle = baseAngle + spread * (i - (this.projectileCount - 1) / 2);
      const p = this.physics.add.image(this.player.x, this.player.y, 'projectile');
      this.projectiles.add(p);
      p.setVelocity(Math.cos(angle) * PROJECTILE_SPEED, Math.sin(angle) * PROJECTILE_SPEED);
      p.setRotation(angle);
    }
  }

  private onProjectileHit(proj: Phaser.GameObjects.GameObject, enemy: Enemy) {
    proj.destroy();
    enemy.hp = (enemy.hp ?? 1) - this.damage;
    if (enemy.hp > 0) return;
    const stats = KIND_STATS[enemy.kind ?? 'chaser'];
    const gain = enemy.elite ? 50 : stats.score;
    this.combo += 1;
    this.comboTimeLeft = COMBO_WINDOW_MS;
    this.score += Math.round(gain * (1 + this.combo * 0.1));
    this.dropGems(enemy.x, enemy.y, enemy.elite ? 3 : stats.gems);
    enemy.destroy();
  }

  private dropGems(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      if (this.gems.length >= MAX_GEMS) this.gems.shift()?.destroy();
      const gem = this.add.image(
        x + Phaser.Math.Between(-10, 10),
        y + Phaser.Math.Between(-10, 10),
        'gem',
      );
      this.gems.push(gem);
    }
  }

  private xpNeed(): number {
    return 8 + (this.level - 1) * 4;
  }

  private gainXp(amount: number) {
    this.xp += amount;
    if (this.xp >= this.xpNeed() && !this.choosing) this.openLevelUp();
  }

  private openLevelUp() {
    this.xp -= this.xpNeed();
    this.level += 1;
    this.choosing = true;
    this.physics.pause();
    this.time.paused = true;
    this.player.setVelocity(0, 0);

    const pool = UPGRADE_DEFS.filter((u) => (this.stacks[u.key] ?? 0) < (u.max ?? 99));
    const picks = Phaser.Utils.Array.Shuffle([...pool]).slice(0, 3);

    const parts: Phaser.GameObjects.GameObject[] = [
      this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x05060a, 0.75).setOrigin(0),
      this.add
        .text(WIDTH / 2, HEIGHT / 2 - 150, `레벨 ${this.level}!  업그레이드 선택`, {
          fontSize: '26px',
          color: '#e8e8f0',
        })
        .setOrigin(0.5),
      this.add
        .text(WIDTH / 2, HEIGHT / 2 + 135, '1 · 2 · 3 키 또는 클릭으로 선택', {
          fontSize: '14px',
          color: '#9aa0b0',
        })
        .setOrigin(0.5),
    ];
    picks.forEach((def, i) => {
      const x = WIDTH / 2 + (i - (picks.length - 1) / 2) * 300;
      const cy = HEIGHT / 2;
      const card = this.add
        .rectangle(x, cy, 260, 190, 0x1e2230)
        .setStrokeStyle(2, 0x4fc3f7)
        .setInteractive({ useHandCursor: true });
      card.on('pointerdown', () => this.chooseUpgrade(def));
      const owned = this.stacks[def.key] ?? 0;
      parts.push(
        card,
        this.add
          .text(x, cy - 68, `${i + 1}. ${def.name}`, { fontSize: '22px', color: '#ffd23f' })
          .setOrigin(0.5),
        this.add
          .text(x, cy - 28, def.blurb, {
            fontSize: '14px',
            color: '#c9cede',
            align: 'center',
            wordWrap: { width: 230 },
          })
          .setOrigin(0.5, 0),
        this.add
          .text(x, cy + 45, def.info(this), { fontSize: '16px', color: '#5be07a' })
          .setOrigin(0.5),
        this.add
          .text(x, cy + 75, `보유 ${owned}${def.max ? ` / 최대 ${def.max}` : ''}`, {
            fontSize: '13px',
            color: '#9aa0b0',
          })
          .setOrigin(0.5),
      );
    });
    this.levelUpUI = this.add.container(0, 0, parts).setDepth(40);

    // 상단 숫자열 + 넘패드 둘 다. 리스너는 chooseUpgrade에서 반드시 정리 —
    // 마우스로 고르면 키 리스너가 살아남아 다음 레벨업에 유령 입력을 만든다.
    const keyRows = [
      [Phaser.Input.Keyboard.KeyCodes.ONE, Phaser.Input.Keyboard.KeyCodes.NUMPAD_ONE],
      [Phaser.Input.Keyboard.KeyCodes.TWO, Phaser.Input.Keyboard.KeyCodes.NUMPAD_TWO],
      [Phaser.Input.Keyboard.KeyCodes.THREE, Phaser.Input.Keyboard.KeyCodes.NUMPAD_THREE],
    ];
    this.levelKeys = [];
    picks.forEach((def, i) => {
      keyRows[i].forEach((code) => {
        const key = this.input.keyboard!.addKey(code);
        key.once('down', () => this.chooseUpgrade(def));
        this.levelKeys.push(key);
      });
    });
  }

  private chooseUpgrade(def: UpgradeDef) {
    if (!this.choosing) return;
    this.levelKeys.forEach((key) => {
      key.removeAllListeners();
      this.input.keyboard!.removeKey(key);
    });
    this.levelKeys = [];
    this.stacks[def.key] = (this.stacks[def.key] ?? 0) + 1;
    def.apply(this);
    if (def.key === 'gauge') this.buildGaugePips();
    this.levelUpUI?.destroy();
    this.levelUpUI = undefined;
    this.choosing = false;
    this.physics.resume();
    this.time.paused = false;
    // 넘친 XP로 연속 레벨업 가능.
    if (this.xp >= this.xpNeed()) this.openLevelUp();
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

  // 게임 시간 기준 경과 초 — 불릿타임은 난이도 시계도 늦춘다 (시간=자원 정체성).
  private elapsedSec(): number {
    return (this.time.now - this.runStart) / 1000;
  }

  private minDensity(): number {
    return BASE_MIN_DENSITY + Math.floor(this.elapsedSec() / DENSITY_GROWTH_SEC);
  }

  private directorTick() {
    if (this.dead) return;
    const now = this.time.now;
    const t = this.elapsedSec();

    // 밸리: 펄스 직후 숨돌림 — 쿼터 충전도 멈춘다.
    if (now < this.valleyUntil) return;

    // 피크: 주기적 웨이브 펄스 — 최소 밀도의 60%를 링으로 한꺼번에.
    if (now >= this.nextPulseAt) {
      const burst = Math.ceil(this.minDensity() * 0.6);
      for (let i = 0; i < burst; i++) {
        const angle = (Math.PI * 2 * i) / burst;
        this.spawnEnemyAt(WIDTH / 2 + Math.cos(angle) * 620, HEIGHT / 2 + Math.sin(angle) * 620);
      }
      this.valleyUntil = now + VALLEY_MS;
      this.nextPulseAt = now + PULSE_INTERVAL_MS;
      return;
    }

    // 최소 밀도 쿼터: 미달이면 즉시 채움 (틱당 8마리 상한 — 프레임 히치 방지).
    const alive = this.enemies.countActive(true);
    const deficit = this.minDensity() - alive;
    if (deficit > 0) {
      for (let i = 0; i < Math.min(deficit, 8); i++) this.spawnEnemy();
      return;
    }

    // 쿼터 충족 중에도 보조 압박: 간격은 시간에 따라 선형 단축.
    const interval = Math.max(200, 600 - t * 1.5);
    if (now - this.lastExtraSpawn >= interval) {
      this.spawnEnemy();
      this.lastExtraSpawn = now;
    }
  }

  // 시간에 따라 스폰 구성이 바뀐다: 추적자만 → +예측자(45초) → +탱커(90초) → +돌진자(150초).
  private pickKind(): EnemyKind {
    const t = this.elapsedSec();
    const roll = Math.random() * 100;
    if (t < 45) return 'chaser';
    if (t < 90) return roll < 25 ? 'inter' : 'chaser';
    if (t < 150) return roll < 25 ? 'inter' : roll < 45 ? 'tank' : 'chaser';
    return roll < 25 ? 'inter' : roll < 40 ? 'tank' : roll < 55 ? 'charger' : 'chaser';
  }

  private spawnEnemy() {
    const edge = Phaser.Math.Between(0, 3);
    const x = edge === 0 ? -20 : edge === 1 ? WIDTH + 20 : Phaser.Math.Between(0, WIDTH);
    const y = edge === 2 ? -20 : edge === 3 ? HEIGHT + 20 : Phaser.Math.Between(0, HEIGHT);
    this.spawnEnemyAt(x, y);
  }

  private spawnEnemyAt(x: number, y: number) {
    if (this.dead) return;
    const kind = this.pickKind();
    const stats = KIND_STATS[kind];
    const enemy = this.physics.add.image(x, y, stats.tex) as Enemy;
    enemy.kind = kind;
    enemy.hp = stats.hp;
    enemy.mode = 'seek';
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
