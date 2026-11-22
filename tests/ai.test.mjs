import { think, configForElo, levelForElo, eloForLevel, ELO_MIN, ELO_MAX, DEFAULT_ELO } from '../js/ai.js';
import { Chess } from '../js/chess.js';

function test(name, fn) {
  try {
    const detail = fn();
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

test('mate in one is found', () => {
  const start = Date.now();
  const r = think({ startFen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', moves: [], level: 4, timeMs: 1500, book: false });
  const elapsed = Date.now() - start;
  assert(r.move, 'no move returned');
  const g = new Chess('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  const m = g.findMoveByUci(r.move);
  assert(m, `illegal move ${r.move}`);
  g.makeMove(m);
  const status = g.status();
  assert(status.checkmate, `expected mate, got ${r.move} (score ${r.score})`);
  return `${r.move} depth ${r.depth} score ${r.score} in ${elapsed}ms`;
});

test('engines play a legal opening', () => {
  const r = think({ startFen: undefined, moves: [], level: 3, timeMs: 800, book: false });
  const g = new Chess();
  const m = g.findMoveByUci(r.move);
  assert(m, `illegal move ${r.move}`);
  return `${r.move} depth ${r.depth} nodes ${r.nodes} score ${r.score} time ${r.time}ms`;
});

test('self play stays consistent', () => {
  const g = new Chess();
  const moves = [];
  for (let i = 0; i < 12; i++) {
    const r = think({ startFen: undefined, moves, level: 2, timeMs: 150, book: true });
    if (!r.move) break;
    const m = g.findMoveByUci(r.move);
    assert(m, `illegal self-play move ${r.move} at ply ${i}`);
    g.makeMove(m);
    moves.push(r.move);
    const st = g.status();
    if (st.over) break;
  }
  return `${moves.length} plies: ${moves.join(' ')}`;
});

test('Elo selector covers 400-2400 and scales strength', () => {
  assert(configForElo(ELO_MIN).elo === 400, 'minimum Elo');
  assert(configForElo(ELO_MAX).elo === 2400, 'maximum Elo');
  assert(configForElo(-100).elo === ELO_MIN, 'clamps low');
  assert(configForElo(99999).elo === ELO_MAX, 'clamps high');
  assert(configForElo(1499).elo === 1500, 'rounds to nearest 100');
  assert(levelForElo(400) === 1 && levelForElo(1200) === 3 && levelForElo(2400) === 5, 'tiers');
  assert(eloForLevel(3) === DEFAULT_ELO, 'legacy level 3 maps to default Elo');

  let previous = null;
  for (let elo = ELO_MIN; elo <= ELO_MAX; elo += 100) {
    const config = configForElo(elo);
    assert(config.elo === elo, `Elo ${elo}`);
    assert(config.maxDepth >= 1 && config.timeMs >= 50, `valid limits at ${elo}`);
    assert(config.blunder >= 0 && config.blunder <= 1, `valid blunder at ${elo}`);
    if (previous) {
      assert(config.timeMs >= previous.timeMs, `time must not decrease at ${elo}`);
      assert(config.maxDepth >= previous.maxDepth, `depth must not decrease at ${elo}`);
      assert(config.blunder <= previous.blunder, `blunder must not increase at ${elo}`);
    }
    previous = config;
  }
  const low = configForElo(400);
  const high = configForElo(2400);
  return `400: d${low.maxDepth}/${low.timeMs}ms/${Math.round(low.blunder * 100)}% · 2400: d${high.maxDepth}/${high.timeMs}ms/${Math.round(high.blunder * 100)}%`;
});

test('custom blunder override still returns a legal move', () => {
  const r = think({ startFen: undefined, moves: [], level: 1, timeMs: 80, maxDepth: 1, blunder: 1, book: false });
  const g = new Chess();
  assert(g.findMoveByUci(r.move), `illegal random move ${r.move}`);
  return r.move;
});

console.log('\nAI tests done');
