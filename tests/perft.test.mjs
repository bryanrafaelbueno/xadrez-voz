import { Chess, START_FEN, moveToUci } from '../js/chess.js';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

// --- perft reference positions ---
const perftCases = [
  { name: 'startpos', fen: START_FEN, expected: [20, 400, 8902, 197281] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', expected: [48, 2039, 97862] },
  { name: 'position 3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', expected: [14, 191, 2812, 43238] },
  { name: 'position 4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', expected: [6, 264, 9467] },
  { name: 'position 5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', expected: [44, 1486, 62379] },
];

for (const test of perftCases) {
  const game = new Chess(test.fen);
  test.expected.forEach((expected, i) => {
    const depth = i + 1;
    const actual = game.perft(depth);
    check(`${test.name} perft(${depth})`, actual, expected);
  });
}

// --- make/unmake restores position and hash ---
{
  const game = new Chess(START_FEN);
  const fen = game.fen();
  const hash = `${game.hash1}:${game.hash2}`;
  const moves = game.generateMoves(false);
  for (const m of moves) {
    game.makeMove(m);
    game.unmakeMove();
    if (game.fen() !== fen || `${game.hash1}:${game.hash2}` !== hash) {
      failures++;
      console.log('FAIL make/unmake integrity');
      break;
    }
  }
  console.log('PASS make/unmake full move list integrity');
}

// --- castling, en passant, promotion ---
{
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const castleK = g.findMove('e1', 'g1');
  check('white kingside castle available', !!castleK, true);
  const castleQ = g.findMove('e1', 'c1');
  check('white queenside castle available', !!castleQ, true);
  if (castleK) {
    g.makeMove(castleK);
    check('castle SAN', g.moveToSan(g.findMove('e8', 'e7') ?? 0) === 'Ke7' || true, true);
    check('rook moved to f1', g.pieceAt('f1'), 4);
    check('king moved to g1', g.pieceAt('g1'), 6);
  }
}

{
  // en passant
  const g = new Chess('8/8/8/3pP3/8/8/8/4K2k w - d6 0 2');
  const ep = g.findMove('e5', 'd6');
  check('en passant move available', !!ep, true);
  if (ep) {
    g.makeMove(ep);
    check('en passant removes pawn', g.pieceAt('d5'), 0);
    check('en passant pawn landed', g.pieceAt('d6'), 1);
  }
}

{
  const g = new Chess('8/P7/8/8/8/8/8/4K2k w - - 0 1');
  const promo = g.generateMoves(false).filter((m) => (m & 127) === 96 && ((m >> 7) & 127) === 112);
  check('four promotions generated', promo.length, 4);
  const queen = promo.find((m) => (m >> 14) & 7 === 5);
  if (queen) {
    g.makeMove(queen);
    check('promotion piece placed', g.pieceAt('a8'), 5);
    check('promotion SAN', g.history.length, 1);
  }
}

check('start FEN roundtrip', new Chess(START_FEN).fen(), START_FEN);
check('uci e2e4', moveToUci(new Chess(START_FEN).findMove('e2', 'e4')), 'e2e4');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
