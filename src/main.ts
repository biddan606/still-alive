import Phaser from 'phaser';

const WIDTH = 960;
const HEIGHT = 540;
const PLAYER_SPEED = 220;
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
const BULLET_DRAIN_MS = 800;
// 불릿타임 발동세: 시작할 때 1칸 선불. 그 값어치(0.8초)는 선불 시간으로 즉시 확보되므로
// 끝까지 쓰면 손해가 없고, 찔끔 쓰고 끊으면 남은 선불을 버린다 — 짧은 남용만 비싸진다.
// 전량 커밋(궁극기) 정체성 + 게이지 0 근처 재점화 익스플로잇 차단을 겸한다.
const BULLET_ACTIVATION_COST = 1;
// 콤보는 실시간으로 식는다 — 시간을 멈춰도 보존되지 않는 게 핵심 규칙.
const COMBO_WINDOW_MS = 2500;
const GAUGE_MAX = 3;
const GAUGE_CHARGE_MS = 1200;
const DASH_DURATION_MS = 160;
const DASH_IFRAME_MS = 300;
// 대시는 반 칸짜리 기본기 — 자주 쓰게 하되, 락아웃으로 무적 체인 탱킹은 막는다.
const DASH_COST = 0.5;
const DASH_LOCKOUT_MS = 400;
// 난이도 디렉터 (ADR 참고: VS 쿼터 + sqrt 곡선 + L4D 피크·밸리)
const DIRECTOR_TICK_MS = 250;
const BASE_MIN_DENSITY = 12;
const DENSITY_GROWTH_SEC = 10; // N초마다 최소 밀도 +1
const PULSE_INTERVAL_MS = 45_000;
const VALLEY_MS = 10_000;
const SPEED_GROWTH = 0.002; // 초당 적 속도 증가율 (선형, 상한 1.6배)
// 격노: 오래 산 몹은 빨라지고 붉어진다 — "안 죽이고 방치"가 안전하지 않게.
const ENRAGE_MS = 25_000;
const ENRAGE_SPEED_MUL = 1.4;
const ENRAGE_TINT = 0xff5a5a;

type EnemyKind = 'chaser' | 'inter' | 'tank' | 'charger' | 'slime';

// Tiny Swords (구버전 CC0) 스프라이트 — 192px 그리드, 0행 idle / 1행 run.
const SHEETS: Record<string, { file: string; cols: number }> = {
  warriorBlue: { file: 'Warrior_Blue.png', cols: 6 },
  warriorRed: { file: 'Warrior_Red.png', cols: 6 },
  torchRed: { file: 'Torch_Red.png', cols: 7 },
  torchYellow: { file: 'Torch_Yellow.png', cols: 7 },
  torchPurple: { file: 'Torch_Purple.png', cols: 7 },
  barrelRed: { file: 'Barrel_Red.png', cols: 4 },
  tntBlue: { file: 'TNT_Blue.png', cols: 7 },
  tntRed: { file: 'TNT_Red.png', cols: 7 },
  tntYellow: { file: 'TNT_Yellow.png', cols: 7 },
};

// 슬라임: 같은 단계끼리 서로를 찾아가 합체. 소(1)→중(2합체)→대(4합체 상당).
// 대형은 원거리 탄막 — 합체 방치의 대가가 탄막 유닛이다.
const SLIME_STAGES = [
  { tex: 'tntBlue', hp: 1, speed: 85, score: 12, gems: 1, scale: 0.3, body: 55, threat: 1 },
  { tex: 'tntRed', hp: 3, speed: 115, score: 25, gems: 2, scale: 0.42, body: 60, threat: 2 },
  { tex: 'tntYellow', hp: 8, speed: 50, score: 60, gems: 4, scale: 0.58, body: 70, threat: 4 },
];
const SLIME_SEEK_RADIUS = 150;
const SLIME_MERGE_DIST = [22, 30];
const MAX_LARGE_SLIMES = 2;
const SLIME_VOLLEY_MS = 3000;
const SLIME_BULLET_SPEED = 140;

// threat: 위협 가중 쿼터용 점수 — 밀도를 마리 수가 아닌 위협 합으로 잰다.
// 약한 몹만 살려둬도 쿼터가 안 차서 신규 스폰을 막을 수 없다 (호딩 견제).
const KIND_STATS: Record<
  EnemyKind,
  { tex: string; hp: number; speed: number; score: number; gems: number; scale: number; body: number; threat: number }
> = {
  chaser: { tex: 'torchRed', hp: 1, speed: 95, score: 10, gems: 1, scale: 0.38, body: 55, threat: 1 },
  inter: { tex: 'torchYellow', hp: 1, speed: 105, score: 15, gems: 1, scale: 0.38, body: 55, threat: 2 },
  tank: { tex: 'barrelRed', hp: 3, speed: 55, score: 20, gems: 2, scale: 0.44, body: 65, threat: 3 },
  charger: { tex: 'torchPurple', hp: 2, speed: 80, score: 20, gems: 2, scale: 0.4, body: 55, threat: 3 },
  slime: { tex: 'tntBlue', hp: 1, speed: 85, score: 12, gems: 1, scale: 0.3, body: 55, threat: 1 },
};

type Enemy = Phaser.Types.Physics.Arcade.SpriteWithDynamicBody & {
  hp?: number;
  kind?: EnemyKind;
  mode?: 'seek' | 'windup' | 'charge';
  modeUntil?: number;
  chargeDir?: Phaser.Math.Vector2;
  stage?: number; // 슬라임 전용: 1(소) 2(중) 3(대)
  nextShotAt?: number; // 슬라임 대형 전용
  spawnedAt?: number; // 격노 판정용
};

// 보스: 5분 도달 시 등장, 처치하면 클리어.
const BOSS_AT_SEC = 300;
const BOSS_HP = 90;
const BOSS_SPEED = 40;
const BOSS_VOLLEY_MS = 3500;
const BOSS_BULLET_SPEED = 150;

// 에셋 없는 WebAudio 신스 — CC0 사운드팩 도입 전 임시. 라이선스 이슈 제로.
class Synth {
  private ctx?: AudioContext;
  private master?: GainNode;
  private filter?: BiquadFilterNode;
  private lastShot = 0;

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 18000;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.filter);
      this.filter.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // 불릿타임 오디오: 세상이 느려지면 소리도 먹먹해진다.
  setWorldSpeed(ws: number) {
    if (this.filter) this.filter.frequency.value = 400 + 17000 * ws * ws;
  }

  private beep(type: OscillatorType, f0: number, f1: number, dur: number, vol: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  shoot() {
    const now = performance.now();
    if (now - this.lastShot < 90) return; // 연사 시 소리 도배 방지
    this.lastShot = now;
    this.beep('square', 880, 220, 0.07, 0.05);
  }
  kill() {
    this.beep('square', 330, 110, 0.12, 0.1);
  }
  bigKill() {
    this.beep('sawtooth', 220, 55, 0.3, 0.18);
  }
  dash() {
    this.beep('sine', 200, 900, 0.15, 0.14);
  }
  pickup(combo: number) {
    this.beep('triangle', 600 + Math.min(combo, 20) * 40, 900 + Math.min(combo, 20) * 40, 0.06, 0.08);
  }
  levelup() {
    this.beep('triangle', 440, 880, 0.25, 0.15);
  }
  merge() {
    this.beep('sine', 150, 450, 0.2, 0.12);
  }
  death() {
    this.beep('sawtooth', 400, 40, 0.6, 0.22);
  }
  victory() {
    this.beep('triangle', 523, 1046, 0.5, 0.2);
  }
}

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

// 시트 공통 규칙: 0행 idle, 1행 run. 애니메이션은 전역 매니저라 1회만 등록.
function buildAnims(scene: Phaser.Scene) {
  const def = (key: string, sheet: string, row: number, frames: number, rate: number) => {
    if (scene.anims.exists(key)) return;
    const cols = SHEETS[sheet].cols;
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(sheet, {
        start: row * cols,
        end: row * cols + frames - 1,
      }),
      frameRate: rate,
      repeat: -1,
    });
  };
  def('warriorBlue-idle', 'warriorBlue', 0, 6, 8);
  def('warriorBlue-run', 'warriorBlue', 1, 6, 12);
  def('warriorRed-run', 'warriorRed', 1, 6, 10);
  for (const k of ['torchRed', 'torchYellow', 'torchPurple']) def(`${k}-run`, k, 1, 6, 10);
  def('barrelRed-run', 'barrelRed', 1, 3, 8);
  for (const k of ['tntBlue', 'tntRed', 'tntYellow']) def(`${k}-run`, k, 1, 6, 10);
  if (!scene.anims.exists('dynamite-spin')) {
    scene.anims.create({
      key: 'dynamite-spin',
      frames: scene.anims.generateFrameNumbers('dynamite', { start: 0, end: 5 }),
      frameRate: 12,
      repeat: -1,
    });
  }
}

class TitleScene extends Phaser.Scene {
  constructor() {
    super('title');
  }

  preload() {
    this.load.setPath('assets/tiny-swords/');
    Object.entries(SHEETS).forEach(([key, s]) =>
      this.load.spritesheet(key, s.file, { frameWidth: 192, frameHeight: 192 }),
    );
    this.load.image('arrow', 'Arrow.png');
    this.load.spritesheet('dynamite', 'Dynamite.png', { frameWidth: 64, frameHeight: 64 });
    this.load.setPath('');
  }

  create() {
    // 애니메이션은 전역 매니저 — 타이틀에서 1회 등록하면 게임 씬도 쓴다.
    buildAnims(this);

    this.add
      .text(WIDTH / 2, 110, 'STILL ALIVE', {
        fontSize: '72px',
        fontStyle: 'bold',
        color: '#7fd8ff',
      })
      .setOrigin(0.5);
    this.add
      .text(WIDTH / 2, 168, '멈춰야 산다', { fontSize: '26px', color: '#e8e8f0' })
      .setOrigin(0.5);

    const hero = this.add.sprite(WIDTH / 2, 300, 'warriorBlue').setScale(1.1);
    hero.play('warriorBlue-idle');

    // 좌우를 배회하는 고블린 — 살아있는 화면.
    const goblin = this.add.sprite(WIDTH / 2 - 260, 330, 'torchRed').setScale(0.5);
    goblin.play('torchRed-run');
    this.tweens.add({
      targets: goblin,
      x: WIDTH / 2 + 260,
      duration: 5200,
      yoyo: true,
      repeat: -1,
      onYoyo: () => goblin.setFlipX(true),
      onRepeat: () => goblin.setFlipX(false),
    });

    this.add
      .text(
        WIDTH / 2,
        418,
        '멈춰 서면 집중이 차오른다 — 그 집중으로 대시(스페이스)와 불릿타임(Shift)을 산다',
        { fontSize: '16px', color: '#9aa0b0' },
      )
      .setOrigin(0.5);
    this.add
      .text(WIDTH / 2, 446, 'WASD 이동 · 스페이스 대시 · Shift 불릿타임 · ESC 일시정지', {
        fontSize: '15px',
        color: '#9aa0b0',
      })
      .setOrigin(0.5);

    const high = Number(localStorage.getItem('highScore') ?? 0);
    if (high > 0) {
      this.add
        .text(WIDTH / 2, 62, `최고 기록 ${high}`, { fontSize: '16px', color: '#ffd23f' })
        .setOrigin(0.5);
    }

    const prompt = this.add
      .text(WIDTH / 2, 496, '아무 키나 눌러 시작', { fontSize: '22px', color: '#ffd23f' })
      .setOrigin(0.5);
    this.tweens.add({ targets: prompt, alpha: 0.25, duration: 700, yoyo: true, repeat: -1 });

    this.input.keyboard!.once('keydown', () => this.scene.start('game'));
    this.input.once('pointerdown', () => this.scene.start('game'));
  }
}

class PrototypeScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  private player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
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
  // 세계 시간: worldSpeed로 스케일해 누적. 적 타이머·난이도 시계의 기준.
  // Phaser의 time.now는 timeScale을 무시하는 실시간이라 세계 시간은 직접 굴려야 한다.
  // 플레이어 쪽(대시·무적)과 콤보는 실시간 유지.
  private gameNow = 0;
  private bulletEngaged = false;
  private bulletPrepaidUntil = 0;
  private lastDir = new Phaser.Math.Vector2(0, -1);
  private score = 0;
  private combo = 0;
  private comboTimeLeft = 0;
  private gauge = GAUGE_MAX;
  private dashUntil = 0;
  private invincibleUntil = 0;
  private dead = false;
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
  private synth = new Synth();
  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private hitstopMs = 0;
  private boss?: Enemy;
  private bossSpawned = false;
  private bossBullets!: Phaser.Physics.Arcade.Group;
  private bossNextVolley = 0;
  private bossBar?: Phaser.GameObjects.Rectangle;

  create() {
    this.dead = false;
    this.paused = false;
    this.choosing = false;
    // 일시정지·레벨업 도중 R 재시작 시 정지 상태가 새 런을 오염시키지 않게 명시 해제.
    this.time.paused = false;
    this.physics.resume();
    this.levelKeys = [];
    this.worldSpeed = 1;
    this.gameNow = 0;
    this.bulletEngaged = false;
    this.bulletPrepaidUntil = 0;
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
    g.clear().fillStyle(0xc44fea).fillCircle(5, 5, 5).generateTexture('bossBullet', 10, 10);
    g.clear().fillStyle(0xfff2c0).fillRect(0, 0, 4, 4).generateTexture('spark', 4, 4);
    g.clear().fillStyle(0x5be07a).fillRect(2, 0, 4, 8).fillRect(0, 2, 8, 4).generateTexture('gem', 8, 8);
    g.destroy();

    buildAnims(this);

    this.player = this.physics.add.sprite(WIDTH / 2, HEIGHT / 2, 'warriorBlue');
    this.player.setScale(0.42);
    this.player.body.setSize(46, 52);
    this.player.play('warriorBlue-idle');
    this.player.setDepth(2);
    this.player.setCollideWorldBounds(true);

    this.enemies = this.physics.add.group();
    this.projectiles = this.physics.add.group();
    this.bossBullets = this.physics.add.group();
    this.boss = undefined;
    this.bossSpawned = false;
    this.hitstopMs = 0;

    this.sparks = this.add.particles(0, 0, 'spark', {
      speed: { min: 60, max: 180 },
      lifespan: 300,
      scale: { start: 1, end: 0 },
      emitting: false,
    });
    this.sparks.setDepth(5);

    // 브라우저 오디오 정책: 첫 입력에서 컨텍스트 활성화.
    this.input.keyboard!.once('keydown', () => this.synth.ensure());
    this.input.once('pointerdown', () => this.synth.ensure());

    this.physics.add.overlap(this.player, this.bossBullets, () => this.onPlayerHit());

    this.lastExtraSpawn = 0;
    this.nextPulseAt = PULSE_INTERVAL_MS;
    this.valleyUntil = 0;
    this.time.addEvent({ delay: DIRECTOR_TICK_MS, loop: true, callback: () => this.directorTick() });

    this.physics.add.overlap(this.player, this.enemies, () => this.onPlayerHit());
    this.physics.add.overlap(this.projectiles, this.enemies, (proj, obj) =>
      this.onProjectileHit(proj as Phaser.GameObjects.GameObject, obj as Enemy),
    );
    // 적끼리 서로 밀어냄 — 포개져서 5마리가 1마리로 보이는 가짜 난이도 방지.
    this.physics.add.collider(this.enemies, this.enemies);

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
          this.add.rectangle(WIDTH / 2, 170, 560, 130, 0x05060a, 0.35).setStrokeStyle(1, 0x4fc3f7, 0.4),
          this.add
            .text(
              WIDTH / 2,
              170,
              '스페이스 — 대시(반 칸): 무적으로 적 벽을 뚫는다\nShift 홀드 — 불릿타임(시작 1칸 + 유지): 세상만 느려지고 나는 그대로\n멈춰 서면 파란 집중 게이지가 차오른다 (둘의 연료)',
              { fontSize: '17px', color: '#e8e8f0', align: 'center', lineSpacing: 10 },
            )
            .setOrigin(0.5)
            .setAlpha(0.9),
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

    // 히트스톱: 묵직한 킬의 실시간 정지 — 짧아서 콤보 타이머 정지는 무시 가능.
    if (this.hitstopMs > 0) {
      this.hitstopMs -= deltaMs;
      this.physics.world.timeScale = 50;
      this.time.timeScale = 0.02;
      this.player.setVelocity(0, 0);
      return;
    }
    const now = this.time.now;

    const dir = new Phaser.Math.Vector2(
      Number(this.cursors.right.isDown || this.wasd.right.isDown) -
        Number(this.cursors.left.isDown || this.wasd.left.isDown),
      Number(this.cursors.down.isDown || this.wasd.down.isDown) -
        Number(this.cursors.up.isDown || this.wasd.up.isDown),
    ).normalize();
    if (dir.lengthSq() > 0) this.lastDir.copy(dir);

    const dashing = now < this.dashUntil;
    if (
      Phaser.Input.Keyboard.JustDown(this.dashKey) &&
      this.gauge >= DASH_COST &&
      now >= this.dashUntil + DASH_LOCKOUT_MS
    ) {
      this.gauge -= DASH_COST;
      this.dashUntil = now + DASH_DURATION_MS;
      this.invincibleUntil = now + DASH_IFRAME_MS;
      this.cameras.main.shake(90, 0.004);
      this.synth.dash();
    }
    // 대시 잔상 — "발동했다"를 몸으로 보여준다.
    if (dashing) {
      const ghost = this.add
        .image(this.player.x, this.player.y, 'warriorBlue', this.player.frame.name)
        .setScale(0.42)
        .setFlipX(this.player.flipX)
        .setTint(0x7fd8ff)
        .setAlpha(0.35)
        .setDepth(this.player.depth - 1);
      this.tweens.add({ targets: ghost, alpha: 0, duration: 250, onComplete: () => ghost.destroy() });
    }

    // 세상은 항상 정상 속도. 슬로우모는 Shift 홀드로 게이지를 태울 때만 (ADR-0003).
    // 발동세 1칸 선불 → 0.8초 선불 시간 확보, 이후 잔여 게이지를 이어서 태운다.
    if (
      !this.bulletEngaged &&
      Phaser.Input.Keyboard.JustDown(this.bulletKey) &&
      this.gauge >= BULLET_ACTIVATION_COST
    ) {
      this.gauge -= BULLET_ACTIVATION_COST;
      this.bulletPrepaidUntil = now + BULLET_DRAIN_MS;
      this.bulletEngaged = true;
    }
    const prepaid = now < this.bulletPrepaidUntil;
    if (!this.bulletKey.isDown || (this.gauge <= 0 && !prepaid)) this.bulletEngaged = false;
    const bulletActive = this.bulletEngaged;
    if (bulletActive && !prepaid) this.gauge = Math.max(0, this.gauge - deltaMs / BULLET_DRAIN_MS);
    const target = bulletActive ? BULLET_TIME_SCALE : 1;
    const lerp = 1 - Math.exp(-10 * (deltaMs / 1000));
    this.worldSpeed = Phaser.Math.Linear(this.worldSpeed, target, lerp);

    // Arcade 물리는 timeScale이 클수록 느려지고, Clock은 작을수록 느려진다 — 서로 반대.
    this.physics.world.timeScale = 1 / this.worldSpeed;
    this.time.timeScale = this.worldSpeed;
    this.gameNow += deltaMs * this.worldSpeed;

    // 플레이어는 실시간 속도 유지: 물리 감속을 역보정해서 슬로우모 속 우위를 만든다.
    const speed = (dashing ? this.moveSpeed * 3.2 : this.moveSpeed) / this.worldSpeed;
    const move = dashing && dir.lengthSq() === 0 ? this.lastDir : dir;
    this.player.setVelocity(move.x * speed, move.y * speed);
    this.player.setAlpha(now < this.invincibleUntil ? 0.4 : 1);
    if (dir.lengthSq() > 0 || dashing) {
      this.player.play('warriorBlue-run', true);
      if (move.x !== 0) this.player.setFlipX(move.x < 0);
    } else {
      this.player.play('warriorBlue-idle', true);
    }

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
        this.synth.pickup(this.combo);
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
    // Shift를 누른 채로는 금지: 게이지 0에서 홀드 시 충전/방전이 프레임 교대로 일어나
    // 공짜 슬로우모를 만드는 루프의 차단.
    const standing = dir.lengthSq() === 0 && !dashing && !this.bulletKey.isDown;
    if (standing && this.gauge < this.gaugeMax) {
      this.gauge = Math.min(this.gaugeMax, this.gauge + deltaMs / GAUGE_CHARGE_MS);
    }

    const speedMul = Math.min(1.6, 1 + this.elapsedSec() * SPEED_GROWTH);
    // 플레이어 실제 화면 속도 (물리 역보정 되돌림) — 예측자 리드 조준용.
    const realVelX = this.player.body.velocity.x * this.worldSpeed;
    const realVelY = this.player.body.velocity.y * this.worldSpeed;

    // 슬라임 합체 판정: 같은 단계끼리 접촉하면 다음 단계로.
    const slimes = this.enemies.getChildren().filter((o) => (o as Enemy).kind === 'slime') as Enemy[];
    for (let i = 0; i < slimes.length; i++) {
      const a = slimes[i];
      const stageA = a.stage ?? 1;
      if (!a.active || stageA >= 3) continue;
      for (let j = i + 1; j < slimes.length; j++) {
        const b = slimes[j];
        if (!b.active || (b.stage ?? 1) !== stageA) continue;
        if (Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y) > SLIME_MERGE_DIST[stageA - 1]) continue;
        if (stageA === 2 && slimes.filter((s) => s.active && s.stage === 3).length >= MAX_LARGE_SLIMES)
          continue;
        this.mergeSlimes(a, b);
        break;
      }
    }
    this.enemies.getChildren().forEach((obj) => {
      const enemy = obj as Enemy;
      const seek = (tx: number, ty: number, spd: number) => {
        const aim = new Phaser.Math.Vector2(tx - enemy.x, ty - enemy.y).normalize().scale(spd);
        enemy.setVelocity(aim.x, aim.y);
        if (Math.abs(aim.x) > 1) enemy.setFlipX(aim.x < 0);
      };
      const stats = KIND_STATS[enemy.kind ?? 'chaser'];
      // 격노: 나이가 임계를 넘으면 가속 + 붉은 틴트. 되돌아가지 않는다. 나이는 세계 시간 기준.
      const enrageMul =
        this.gameNow - (enemy.spawnedAt ?? this.gameNow) >= ENRAGE_MS ? ENRAGE_SPEED_MUL : 1;
      if (enrageMul > 1) enemy.setTint(ENRAGE_TINT);
      const spd = stats.speed * speedMul * enrageMul;
      switch (enemy.kind) {
        case 'inter':
          seek(
            this.player.x + realVelX * INTERCEPT_LEAD_SEC,
            this.player.y + realVelY * INTERCEPT_LEAD_SEC,
            spd,
          );
          break;
        case 'slime': {
          const stage = enemy.stage ?? 1;
          const sStats = SLIME_STAGES[stage - 1];
          const sSpd = sStats.speed * speedMul * enrageMul;
          if (stage === 3) {
            // 대형: 느린 추적 + 주기적 4방향 탄. 합체 방치의 대가.
            seek(this.player.x, this.player.y, sSpd);
            if (this.gameNow >= (enemy.nextShotAt ?? 0)) {
              enemy.nextShotAt = this.gameNow + SLIME_VOLLEY_MS;
              const base = Phaser.Math.Angle.Between(enemy.x, enemy.y, this.player.x, this.player.y);
              for (let k = 0; k < 4; k++) {
                const angle = base + (Math.PI / 2) * k;
                const bullet = this.physics.add.sprite(enemy.x, enemy.y, 'dynamite');
                bullet.setScale(0.5);
                bullet.body.setSize(24, 24);
                bullet.play('dynamite-spin');
                this.bossBullets.add(bullet);
                bullet.setVelocity(
                  Math.cos(angle) * SLIME_BULLET_SPEED,
                  Math.sin(angle) * SLIME_BULLET_SPEED,
                );
              }
            }
            break;
          }
          // 소·중형: 근처 같은 단계 동족이 있으면 그쪽으로 (합체 시도), 없으면 플레이어에게.
          let mate: Enemy | null = null;
          let bestMate = SLIME_SEEK_RADIUS;
          for (const s of slimes) {
            if (s === enemy || !s.active || (s.stage ?? 1) !== stage) continue;
            const d = Phaser.Math.Distance.Between(enemy.x, enemy.y, s.x, s.y);
            if (d < bestMate) {
              bestMate = d;
              mate = s;
            }
          }
          if (mate) seek(mate.x, mate.y, sSpd);
          else if (stage === 2)
            seek(
              this.player.x + realVelX * INTERCEPT_LEAD_SEC,
              this.player.y + realVelY * INTERCEPT_LEAD_SEC,
              sSpd,
            );
          else seek(this.player.x, this.player.y, sSpd);
          break;
        }
        case 'charger': {
          if (enemy.mode === 'windup') {
            enemy.setVelocity(0, 0);
            // 경고 점멸도 세계 시간 — 불릿타임 중엔 점멸·전환 모두 함께 늦어진다.
            enemy.setAlpha(0.4 + 0.6 * Math.abs(Math.sin(this.gameNow / 60)));
            if (this.gameNow >= (enemy.modeUntil ?? 0)) {
              enemy.mode = 'charge';
              enemy.modeUntil = this.gameNow + CHARGER_CHARGE_MS;
              enemy.chargeDir = new Phaser.Math.Vector2(
                this.player.x - enemy.x,
                this.player.y - enemy.y,
              ).normalize();
              enemy.setAlpha(1);
            }
          } else if (enemy.mode === 'charge') {
            const d = enemy.chargeDir!;
            enemy.setVelocity(
              d.x * CHARGER_CHARGE_SPEED * speedMul * enrageMul,
              d.y * CHARGER_CHARGE_SPEED * speedMul * enrageMul,
            );
            if (this.gameNow >= (enemy.modeUntil ?? 0)) enemy.mode = 'seek';
          } else {
            seek(this.player.x, this.player.y, spd);
            const dist = Phaser.Math.Distance.Between(enemy.x, enemy.y, this.player.x, this.player.y);
            if (dist < CHARGER_RANGE) {
              enemy.mode = 'windup';
              enemy.modeUntil = this.gameNow + CHARGER_WINDUP_MS;
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
    this.synth.setWorldSpeed(this.worldSpeed);

    // 보스: 5분 도달 시 1회 등장. 느린 추적 + 주기적 방사 탄막.
    if (!this.bossSpawned && this.elapsedSec() >= BOSS_AT_SEC) this.spawnBoss();
    if (this.boss?.active) {
      const b = this.boss;
      const aim = new Phaser.Math.Vector2(this.player.x - b.x, this.player.y - b.y)
        .normalize()
        .scale(BOSS_SPEED);
      b.setVelocity(aim.x, aim.y);
      if (Math.abs(aim.x) > 1) b.setFlipX(aim.x < 0);
      if (this.gameNow >= this.bossNextVolley) {
        this.bossNextVolley = this.gameNow + BOSS_VOLLEY_MS;
        for (let i = 0; i < 10; i++) {
          const angle = (Math.PI * 2 * i) / 10;
          const bullet = this.physics.add.image(b.x, b.y, 'bossBullet');
          this.bossBullets.add(bullet);
          bullet.setVelocity(Math.cos(angle) * BOSS_BULLET_SPEED, Math.sin(angle) * BOSS_BULLET_SPEED);
        }
      }
      this.bossBar?.setPosition(b.x - 30, b.y - 52);
      this.bossBar?.setSize(60 * Math.max(0, (b.hp ?? 0) / BOSS_HP), 5);
    }
    this.bossBullets.getChildren().forEach((obj) => {
      const bullet = obj as Phaser.Types.Physics.Arcade.ImageWithDynamicBody;
      if (bullet.x < -30 || bullet.x > WIDTH + 30 || bullet.y < -30 || bullet.y > HEIGHT + 30)
        bullet.destroy();
    });
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
      const p = this.physics.add.image(this.player.x, this.player.y, 'arrow');
      p.setScale(0.35);
      p.body.setSize(28, 28);
      this.projectiles.add(p);
      p.setVelocity(Math.cos(angle) * PROJECTILE_SPEED, Math.sin(angle) * PROJECTILE_SPEED);
      // Arrow.png는 위를 향하므로 +90도 보정.
      p.setRotation(angle + Math.PI / 2);
    }
    this.synth.shoot();
  }

  private onProjectileHit(proj: Phaser.GameObjects.GameObject, enemy: Enemy) {
    proj.destroy();
    enemy.hp = (enemy.hp ?? 1) - this.damage;
    if (enemy.hp > 0) return;
    const stats =
      enemy.kind === 'slime'
        ? SLIME_STAGES[(enemy.stage ?? 1) - 1]
        : KIND_STATS[enemy.kind ?? 'chaser'];
    this.combo += 1;
    this.comboTimeLeft = COMBO_WINDOW_MS;
    this.score += Math.round(stats.score * (1 + this.combo * 0.1));
    this.dropGems(enemy.x, enemy.y, stats.gems);

    // 킬 juice: 파편은 전 킬, 히트스톱·셰이크·중타격음은 묵직한 킬만.
    const heavy =
      enemy.kind === 'tank' || enemy.kind === 'charger' || (enemy.kind === 'slime' && (enemy.stage ?? 1) >= 2);
    this.sparks.explode(heavy ? 16 : 8, enemy.x, enemy.y);
    if (heavy) {
      this.hitstopMs = 40;
      this.cameras.main.shake(60, 0.003);
      this.synth.bigKill();
    } else {
      this.synth.kill();
    }
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
    this.synth.levelup();
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

  private onPlayerHit() {
    if (this.dead || this.time.now < this.invincibleUntil) return;
    this.synth.death();
    this.cameras.main.shake(250, 0.01);
    this.sparks.explode(24, this.player.x, this.player.y);
    this.endRun(false);
  }

  private spawnBoss() {
    this.bossSpawned = true;
    const boss = this.physics.add.sprite(WIDTH / 2, -60, 'warriorRed') as Enemy;
    boss.setScale(0.9);
    boss.body.setSize(70, 80);
    boss.play('warriorRed-run');
    boss.setDepth(1);
    boss.hp = BOSS_HP;
    this.boss = boss;
    this.bossNextVolley = this.gameNow + 1500;
    this.bossBar = this.add.rectangle(0, 0, 60, 5, 0xe4573d).setOrigin(0, 0.5).setDepth(12);
    // Phaser는 group vs sprite 콜백 인자 순서가 뒤집힐 수 있어 boss가 아닌 쪽을 투사체로 판별.
    this.physics.add.overlap(this.projectiles, boss, (a, b) => {
      const proj = (a as Phaser.GameObjects.GameObject) === boss ? b : a;
      this.onBossHit(proj as Phaser.GameObjects.GameObject);
    });
    this.physics.add.overlap(this.player, boss, () => this.onPlayerHit());
    const warn = this.add
      .text(WIDTH / 2, 120, '보스 접근!', { fontSize: '32px', color: '#e4573d' })
      .setOrigin(0.5)
      .setDepth(25);
    this.tweens.add({ targets: warn, alpha: 0, delay: 1600, duration: 500, onComplete: () => warn.destroy() });
    this.cameras.main.shake(300, 0.005);
  }

  private onBossHit(proj: Phaser.GameObjects.GameObject) {
    const boss = this.boss;
    if (!boss?.active) return;
    proj.destroy();
    boss.hp = (boss.hp ?? 1) - this.damage;
    this.sparks.explode(4, boss.x, boss.y);
    if (boss.hp > 0) return;
    this.combo += 1;
    this.comboTimeLeft = COMBO_WINDOW_MS;
    this.score += Math.round(300 * (1 + this.combo * 0.1));
    this.sparks.explode(40, boss.x, boss.y);
    this.hitstopMs = 250;
    this.cameras.main.shake(400, 0.012);
    this.synth.victory();
    boss.destroy();
    this.bossBar?.destroy();
    this.endRun(true);
  }

  private endRun(won: boolean) {
    this.dead = true;
    this.physics.pause();
    const high = Math.max(this.score, this.highScore());
    localStorage.setItem('highScore', String(high));
    const t = Math.floor(this.elapsedSec());
    const clock = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    this.add
      .rectangle(0, 0, WIDTH, HEIGHT, 0x05060a, 0.7)
      .setOrigin(0)
      .setDepth(20);
    this.add
      .text(WIDTH / 2, HEIGHT / 2 - 52, won ? '클리어!' : '사망', {
        fontSize: '36px',
        color: won ? '#5be07a' : '#e4573d',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(WIDTH / 2, HEIGHT / 2, `점수 ${this.score}   최고 ${high}   생존 ${clock}`, {
        fontSize: '26px',
        color: '#e8e8f0',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.add
      .text(WIDTH / 2, HEIGHT / 2 + 44, 'R 또는 스페이스 — 즉시 재시작 · ESC — 타이틀로', {
        fontSize: '18px',
        color: '#ffd23f',
      })
      .setOrigin(0.5)
      .setDepth(21);
    this.input.keyboard!.once('keydown-SPACE', () => this.scene.restart());
    this.input.keyboard!.once('keydown-ESC', () => this.scene.start('title'));
  }

  // 세계 시간 기준 경과 초 — 불릿타임은 난이도 시계도 늦추고, 일시정지·레벨업 중엔 멈춘다.
  private elapsedSec(): number {
    return this.gameNow / 1000;
  }

  private minDensity(): number {
    return BASE_MIN_DENSITY + Math.floor(this.elapsedSec() / DENSITY_GROWTH_SEC);
  }

  // 현재 위협 합. 쿼터는 이 값과 비교한다 — 마리 수가 아니라.
  private currentThreat(): number {
    let sum = 0;
    this.enemies.getChildren().forEach((obj) => {
      const e = obj as Enemy;
      if (!e.active) return;
      sum +=
        e.kind === 'slime'
          ? SLIME_STAGES[(e.stage ?? 1) - 1].threat
          : KIND_STATS[e.kind ?? 'chaser'].threat;
    });
    return sum;
  }

  private directorTick() {
    if (this.dead) return;
    // 디렉터도 세계 시간으로 산다 — 불릿타임 중엔 펄스·보조 스폰 간격도 늦어진다.
    const now = this.gameNow;
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

    // 최소 밀도 쿼터: 위협 점수 미달이면 즉시 채움 (틱당 8마리 상한 — 프레임 히치 방지).
    const deficit = this.minDensity() - this.currentThreat();
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
    if (t < 60) return roll < 25 ? 'inter' : 'chaser';
    if (t < 90) return roll < 20 ? 'inter' : roll < 35 ? 'slime' : 'chaser';
    if (t < 150) return roll < 20 ? 'inter' : roll < 35 ? 'slime' : roll < 50 ? 'tank' : 'chaser';
    return roll < 20 ? 'inter' : roll < 35 ? 'slime' : roll < 48 ? 'tank' : roll < 60 ? 'charger' : 'chaser';
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
    const enemy = this.physics.add.sprite(x, y, stats.tex) as Enemy;
    enemy.setScale(stats.scale);
    enemy.body.setSize(stats.body, stats.body);
    enemy.play(`${stats.tex}-run`);
    enemy.kind = kind;
    enemy.hp = stats.hp;
    enemy.mode = 'seek';
    enemy.spawnedAt = this.gameNow;
    if (kind === 'slime') enemy.stage = 1;
    this.enemies.add(enemy);
  }

  private mergeSlimes(a: Enemy, b: Enemy) {
    const stage = Math.min(3, (a.stage ?? 1) + 1);
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    a.destroy();
    b.destroy();
    const stats = SLIME_STAGES[stage - 1];
    const merged = this.physics.add.sprite(x, y, stats.tex) as Enemy;
    merged.body.setSize(stats.body, stats.body);
    merged.play(`${stats.tex}-run`);
    merged.kind = 'slime';
    merged.stage = stage;
    merged.hp = stats.hp;
    merged.mode = 'seek';
    merged.spawnedAt = this.gameNow; // 합체 = 새 개체, 격노 타이머 리셋
    merged.nextShotAt = this.gameNow + 1200;
    this.enemies.add(merged);
    // 합체 연출: 팝 스케일 + 파편 + 저음 — 인과가 보여야 "끊어라" 결정이 성립한다.
    merged.setScale(stats.scale * 0.4);
    this.tweens.add({ targets: merged, scale: stats.scale, duration: 180, ease: 'Back.easeOut' });
    this.sparks.explode(10, x, y);
    this.synth.merge();
  }

  private highScore(): number {
    return Number(localStorage.getItem('highScore') ?? 0);
  }
}

// 디버그·자동 테스트에서 씬 상태를 들여다보기 위한 노출.
(window as unknown as { game: Phaser.Game }).game = new Phaser.Game({
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
  scene: [TitleScene, PrototypeScene],
});
