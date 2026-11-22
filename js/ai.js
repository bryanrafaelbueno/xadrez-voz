/**
 * Xadrez Voz — chess engine.
 * Alpha-beta / PVS with transposition table, quiescence search,
 * late move reductions, killers, history heuristic and tapered evaluation.
 *
 * It is intentionally dependency free so it can run inside a Web Worker.
 */

import {
  Chess, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  FLAG_CAPTURE, FLAG_EP, FLAG_KCASTLE, FLAG_QCASTLE,
  moveFrom, moveTo, movePromotion, moveFlags, moveToUci,
} from './chess.js';

export const LEVELS = {
  1: { name: 'Iniciante', nameEn: 'Beginner', maxDepth: 2, timeMs: 200, blunder: 0.35 },
  2: { name: 'Casual', nameEn: 'Casual', maxDepth: 4, timeMs: 500, blunder: 0.15 },
  3: { name: 'Clube', nameEn: 'Club', maxDepth: 7, timeMs: 1200, blunder: 0.03 },
  4: { name: 'Forte', nameEn: 'Strong', maxDepth: 10, timeMs: 2500, blunder: 0 },
  5: { name: 'Mestre', nameEn: 'Master', maxDepth: 16, timeMs: 4200, blunder: 0 },
};

/**
 * Approximate playing strength selector.
 *
 * Each entry trades off search depth, thinking time and the chance of playing
 * a random legal move ("blunder"). Elo values are estimates, not a calibrated
 * rating list: real strength depends on the position, time control and CPU.
 */
export const ELO_MIN = 400;
export const ELO_MAX = 2400;
export const ELO_STEP = 100;
export const DEFAULT_ELO = 1500;

const ELO_TABLE = [
  { elo: 400, maxDepth: 1, timeMs: 100, blunder: 0.45, book: false },
  { elo: 500, maxDepth: 2, timeMs: 130, blunder: 0.36, book: false },
  { elo: 600, maxDepth: 2, timeMs: 160, blunder: 0.28, book: false },
  { elo: 700, maxDepth: 3, timeMs: 200, blunder: 0.22, book: true },
  { elo: 800, maxDepth: 3, timeMs: 250, blunder: 0.17, book: true },
  { elo: 900, maxDepth: 4, timeMs: 320, blunder: 0.13, book: true },
  { elo: 1000, maxDepth: 4, timeMs: 400, blunder: 0.10, book: true },
  { elo: 1100, maxDepth: 5, timeMs: 480, blunder: 0.075, book: true },
  { elo: 1200, maxDepth: 5, timeMs: 600, blunder: 0.055, book: true },
  { elo: 1300, maxDepth: 6, timeMs: 750, blunder: 0.04, book: true },
  { elo: 1400, maxDepth: 7, timeMs: 900, blunder: 0.028, book: true },
  { elo: 1500, maxDepth: 7, timeMs: 1100, blunder: 0.018, book: true },
  { elo: 1600, maxDepth: 8, timeMs: 1300, blunder: 0.012, book: true },
  { elo: 1700, maxDepth: 8, timeMs: 1600, blunder: 0.008, book: true },
  { elo: 1800, maxDepth: 9, timeMs: 1900, blunder: 0.005, book: true },
  { elo: 1900, maxDepth: 9, timeMs: 2200, blunder: 0.003, book: true },
  { elo: 2000, maxDepth: 10, timeMs: 2600, blunder: 0.002, book: true },
  { elo: 2100, maxDepth: 10, timeMs: 3000, blunder: 0.001, book: true },
  { elo: 2200, maxDepth: 11, timeMs: 3400, blunder: 0, book: true },
  { elo: 2300, maxDepth: 12, timeMs: 4000, blunder: 0, book: true },
  { elo: 2400, maxDepth: 13, timeMs: 4600, blunder: 0, book: true },
];

export function levelForElo(elo) {
  const value = Number.isFinite(Number(elo)) ? Number(elo) : DEFAULT_ELO;
  if (value <= 700) return 1;
  if (value <= 1100) return 2;
  if (value <= 1500) return 3;
  if (value <= 1900) return 4;
  return 5;
}

export function configForElo(elo) {
  let value = Number.isFinite(Number(elo)) ? Number(elo) : DEFAULT_ELO;
  value = Math.max(ELO_MIN, Math.min(ELO_MAX, Math.round(value / ELO_STEP) * ELO_STEP));
  const entry = ELO_TABLE.find((item) => item.elo === value) || ELO_TABLE[Math.floor((DEFAULT_ELO - ELO_MIN) / ELO_STEP)];
  return {
    ...entry,
    level: levelForElo(value),
  };
}

export function eloForLevel(level) {
  return { 1: 600, 2: 1000, 3: 1500, 4: 1900, 5: 2300 }[Number(level)] || DEFAULT_ELO;
}

const INF = 32500;
const MATE = 32000;
const MAX_PLY = 64;

const MG_VALUE = [82, 337, 365, 477, 1025, 0];
const EG_VALUE = [94, 281, 297, 512, 936, 0];
const PHASE_VALUE = [0, 1, 1, 2, 4, 0];
const PIECE_VALUE = [100, 320, 330, 500, 900, 0];

/* PeSTO style piece square tables, laid out from a8 to h1. */
const MG_PST = [
  [ // pawn
    0, 0, 0, 0, 0, 0, 0, 0,
    98, 134, 61, 95, 68, 126, 34, -11,
    -6, 7, 26, 31, 65, 56, 25, -20,
    -14, 13, 6, 21, 23, 12, 17, -23,
    -27, -2, -5, 12, 17, 6, 10, -25,
    -26, -4, -4, -10, 3, 3, 33, -12,
    -35, -1, -20, -23, -15, 24, 38, -22,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [ // knight
    -167, -89, -34, -49, 61, -97, -15, -107,
    -73, -41, 72, 36, 23, 62, 7, -17,
    -47, 60, 37, 65, 84, 129, 73, 44,
    -9, 17, 19, 53, 37, 69, 18, 22,
    -13, 4, 16, 13, 28, 19, 21, -8,
    -23, -9, 12, 10, 19, 17, 25, -16,
    -29, -53, -12, -3, -1, 18, -14, -19,
    -105, -21, -58, -33, -17, -28, -19, -23,
  ],
  [ // bishop
    -29, 4, -82, -37, -25, -42, 7, -8,
    -26, 16, -18, -13, 30, 59, 18, -47,
    -16, 37, 43, 40, 35, 50, 37, -2,
    -4, 5, 19, 50, 37, 37, 7, -2,
    -6, 13, 13, 26, 34, 12, 10, 4,
    0, 15, 15, 15, 14, 27, 18, 10,
    4, 15, 16, 0, 7, 21, 33, 1,
    -33, -3, -14, -21, -13, -12, -39, -21,
  ],
  [ // rook
    32, 42, 32, 51, 63, 9, 31, 43,
    27, 32, 58, 62, 80, 67, 26, 44,
    -5, 19, 26, 36, 17, 45, 61, 16,
    -24, -11, 7, 26, 24, 35, -8, -20,
    -36, -26, -12, -1, 9, -7, 6, -23,
    -45, -25, -16, -17, 3, 0, -5, -33,
    -44, -16, -20, -9, -1, 11, -6, -71,
    -19, -13, 1, 17, 16, 7, -37, -26,
  ],
  [ // queen
    -28, 0, 29, 12, 59, 44, 43, 45,
    -24, -39, -5, 1, -16, 57, 28, 54,
    -13, -17, 7, 8, 29, 56, 47, 57,
    -27, -27, -16, -16, -1, 17, -2, 1,
    -9, -26, -9, -10, -2, -4, 3, -3,
    -14, 2, -11, -2, -5, 2, 14, 5,
    -35, -8, 11, 2, 8, 15, -3, 1,
    -1, -18, -9, 10, -15, -25, -31, -50,
  ],
  [ // king
    -65, 23, 16, -15, -56, -34, 2, 13,
    29, -1, -20, -7, -8, -4, -38, -29,
    -9, 24, 2, -16, -20, 6, 22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49, -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
    1, 7, -8, -64, -43, -16, 9, 8,
    -15, 36, 12, -54, 8, -28, 24, 14,
  ],
];

const EG_PST = [
  [ // pawn
    0, 0, 0, 0, 0, 0, 0, 0,
    178, 173, 158, 134, 147, 132, 165, 187,
    94, 100, 85, 67, 56, 53, 82, 84,
    32, 24, 13, 5, -2, 4, 17, 17,
    13, 9, -3, -7, -7, -8, 3, -1,
    4, 7, -6, 1, 0, -5, -1, -8,
    13, 8, 8, 10, 13, 0, 2, -7,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [ // knight
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25, -8, -25, -2, -9, -25, -24, -52,
    -24, -20, 10, 9, -1, -9, -19, -41,
    -17, 3, 22, 22, 22, 11, 8, -18,
    -18, -6, 16, 25, 16, 17, 4, -18,
    -23, -3, -1, 15, 10, -3, -20, -22,
    -42, -20, -10, -5, -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64,
  ],
  [ // bishop
    -14, -21, -11, -8, -7, -9, -17, -24,
    -8, -4, 7, -12, -3, -13, -4, -14,
    2, -8, 0, -1, -2, 6, 0, 4,
    -3, 9, 12, 9, 14, 10, 3, 2,
    -6, 3, 13, 19, 7, 10, -3, -9,
    -12, -3, 8, 10, 13, 3, -7, -15,
    -14, -18, -7, -1, 4, -9, -15, -27,
    -23, -9, -23, -5, -9, -16, -5, -17,
  ],
  [ // rook
    13, 10, 18, 15, 12, 12, 8, 5,
    11, 13, 13, 11, -3, 3, 8, 3,
    7, 7, 7, 5, 4, -3, -5, -3,
    4, 3, 13, 1, 2, 1, -1, 2,
    3, 5, 8, 4, -5, -6, -8, -11,
    -4, 0, -5, -1, -7, -12, -8, -16,
    -6, -6, 0, 2, -9, -9, -11, -3,
    -9, 2, 3, -1, -5, -13, 4, -20,
  ],
  [ // queen
    -9, 22, 22, 27, 27, 19, 10, 20,
    -17, 20, 32, 41, 58, 25, 30, 0,
    -20, 6, 9, 49, 47, 35, 19, 9,
    3, 22, 24, 45, 57, 40, 57, 36,
    -18, 28, 19, 47, 31, 34, 39, 23,
    -16, -27, 15, 6, 9, 17, 10, 5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43, -5, -32, -20, -41,
  ],
  [ // king
    -74, -35, -18, -18, -11, 15, 4, -17,
    -12, 17, 14, 17, 17, 38, 23, 11,
    10, 17, 23, 15, 20, 45, 44, 13,
    -8, 22, 24, 27, 26, 33, 26, 3,
    -18, -4, 21, 24, 27, 23, 9, -11,
    -19, -3, 11, 21, 23, 16, 7, -9,
    -27, -11, 4, 13, 14, 4, -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43,
  ],
];

const PASSED_MG = [0, 6, 12, 22, 38, 62, 100, 0];
const PASSED_EG = [0, 10, 20, 38, 66, 110, 170, 0];

const TT_SIZE = 1 << 19;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 0;
const TT_ALPHA = 1;
const TT_BETA = 2;

const ABORT = Symbol('abort');

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function pieceType(piece) {
  return Math.abs(piece) - 1;
}

class Engine {
  constructor(game) {
    this.game = game;
    this.nodes = 0;
    this.deadline = Infinity;
    this.startTime = 0;
    this.ttKey = new Uint32Array(TT_SIZE);
    this.ttCheck = new Uint32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE);
    this.ttScore = new Int32Array(TT_SIZE);
    this.ttDepth = new Int8Array(TT_SIZE);
    this.ttFlag = new Uint8Array(TT_SIZE);
    this.ttUsed = new Uint8Array(TT_SIZE);
    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(2 * 128 * 128);
    this.pv = new Int32Array(MAX_PLY * MAX_PLY);
    this.pvLength = new Int32Array(MAX_PLY);
    this.rootBestMove = 0;
    this.rootBestScore = 0;
    this.rootBestPv = [];
  }

  checkTime() {
    if (now() > this.deadline) throw ABORT;
  }

  /* -------------------------------- evaluation -------------------------------- */

  evaluate() {
    const game = this.game;
    const b = game.board;
    let mg = 0;
    let eg = 0;
    let phase = 0;
    const bishops = [0, 0];
    const pawns = [[], []];
    const pawnFiles = [new Int32Array(8), new Int32Array(8)];
    const rooks = [[], []];
    let whiteMaterial = 0;
    let blackMaterial = 0;

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const piece = b[sq];
      if (!piece) continue;
      const side = piece > 0 ? 0 : 1;
      const type = Math.abs(piece) - 1;
      const file = sq & 7;
      const rank = sq >> 4;
      const idx = side === 0 ? (7 - rank) * 8 + file : rank * 8 + file;
      const sign = side === 0 ? 1 : -1;
      mg += sign * (MG_VALUE[type] + MG_PST[type][idx]);
      eg += sign * (EG_VALUE[type] + EG_PST[type][idx]);
      phase += PHASE_VALUE[type];
      if (side === 0) whiteMaterial += PIECE_VALUE[type];
      else blackMaterial += PIECE_VALUE[type];
      if (type === 0) {
        pawns[side].push(sq);
        pawnFiles[side][file]++;
      } else if (type === 2) {
        bishops[side]++;
      } else if (type === 3) {
        rooks[side].push(sq);
      }
    }
    if (phase > 24) phase = 24;

    // bishop pair
    if (bishops[0] >= 2) { mg += 26; eg += 42; }
    if (bishops[1] >= 2) { mg -= 26; eg -= 42; }

    // pawn structure + passed pawns
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const own = pawns[side];
      const enemy = pawns[1 - side];
      const files = pawnFiles[side];
      for (const sq of own) {
        const file = sq & 7;
        const relRank = side === 0 ? (sq >> 4) : 7 - (sq >> 4);
        // doubled
        if (files[file] > 1) { mg -= sign * 10; eg -= sign * 16; }
        // isolated
        const hasLeft = file > 0 && files[file - 1] > 0;
        const hasRight = file < 7 && files[file + 1] > 0;
        if (!hasLeft && !hasRight) { mg -= sign * 14; eg -= sign * 22; }
        // passed
        let passed = true;
        for (const esq of enemy) {
          const ef = esq & 7;
          const er = esq >> 4;
          if (Math.abs(ef - file) > 1) continue;
          if (side === 0 ? er > (sq >> 4) : er < (sq >> 4)) { passed = false; break; }
        }
        if (passed) {
          mg += sign * PASSED_MG[relRank];
          eg += sign * PASSED_EG[relRank];
        }
      }
    }

    // rooks on open / semi-open files, seventh rank
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      for (const sq of rooks[side]) {
        const file = sq & 7;
        const ownPawns = pawnFiles[side][file];
        const enemyPawns = pawnFiles[1 - side][file];
        if (!ownPawns && !enemyPawns) { mg += sign * 22; eg += sign * 12; }
        else if (!ownPawns) { mg += sign * 10; eg += sign * 6; }
        const relRank = side === 0 ? (sq >> 4) : 7 - (sq >> 4);
        if (relRank === 6) { mg += sign * 20; eg += sign * 10; }
      }
    }

    // king pawn shield / castled bonus
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const kingSq = game.kings[side];
      if (kingSq < 0) continue;
      const kf = kingSq & 7;
      const kr = kingSq >> 4;
      let shield = 0;
      for (const sq of pawns[side]) {
        const f = sq & 7;
        const r = sq >> 4;
        if (Math.abs(f - kf) <= 1) {
          if (side === 0 ? (r >= kr && r <= kr + 2) : (r <= kr && r >= kr - 2)) shield++;
        }
      }
      mg += sign * shield * 9;
      if (side === 0 && kr === 0 && (kf === 6 || kf === 2)) mg += sign * 18;
      if (side === 1 && kr === 7 && (kf === 6 || kf === 2)) mg -= 18;
    }

    // simplifications / imbalance
    const materialDiff = whiteMaterial - blackMaterial;
    if (Math.abs(materialDiff) > 150) {
      // encourage trading when ahead in the endgame (bare kings mop-up is handled by king PST)
      eg += Math.sign(materialDiff) * 8;
    }

    mg += 10;
    const score = ((mg * (24 - phase) + eg * phase) / 24) | 0;
    return game.turn === WHITE ? score : -score;
  }

  /* --------------------------------- ordering --------------------------------- */

  scoreMove(move, ttMove, ply) {
    if (move === ttMove) return 10_000_000;
    const game = this.game;
    const flags = moveFlags(move);
    const to = moveTo(move);
    const promo = movePromotion(move);
    let score = 0;
    if (flags & FLAG_CAPTURE) {
      const victim = flags & FLAG_EP ? PAWN : Math.abs(game.board[to]) || PAWN;
      const attacker = Math.abs(game.board[moveFrom(move)]) || PAWN;
      score = 1_000_000 + PIECE_VALUE[victim - 1] * 16 - PIECE_VALUE[attacker - 1];
    }
    if (promo) score += 900_000 + PIECE_VALUE[promo - 1];
    if (!score) {
      if (move === this.killers[ply * 2]) score = 800_000;
      else if (move === this.killers[ply * 2 + 1]) score = 790_000;
      else {
        const side = game.turn === WHITE ? 0 : 1;
        score = this.history[side * 16384 + moveFrom(move) * 128 + to];
      }
    }
    return score;
  }

  orderMoves(moves, ttMove, ply) {
    const scored = new Array(moves.length);
    for (let i = 0; i < moves.length; i++) scored[i] = [moves[i], this.scoreMove(moves[i], ttMove, ply)];
    scored.sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < moves.length; i++) moves[i] = scored[i][0];
    return moves;
  }

  /* ---------------------------------- search ---------------------------------- */

  ttProbe() {
    const game = this.game;
    const idx = (game.hash1 ^ (game.hash2 >>> 16)) & TT_MASK;
    if (this.ttUsed[idx] && this.ttKey[idx] === game.hash1 && this.ttCheck[idx] === game.hash2) {
      return {
        idx,
        move: this.ttMove[idx],
        score: this.ttScore[idx],
        depth: this.ttDepth[idx],
        flag: this.ttFlag[idx],
      };
    }
    return { idx, move: 0, score: 0, depth: -1, flag: TT_EXACT };
  }

  ttStore(depth, score, flag, move, idx) {
    this.ttKey[idx] = this.game.hash1;
    this.ttCheck[idx] = this.game.hash2;
    this.ttScore[idx] = score;
    this.ttDepth[idx] = depth;
    this.ttFlag[idx] = flag;
    this.ttMove[idx] = move;
    this.ttUsed[idx] = 1;
  }

  search(depth, alpha, beta, ply) {
    const game = this.game;
    this.nodes++;
    if ((this.nodes & 1023) === 0) this.checkTime();

    if (ply > 0) {
      if (game.halfmove >= 100 || game.isRepetition(2)) return 0;
      if (ply >= MAX_PLY - 2) return this.evaluate();
    }
    const inCheck = game.inCheck();
    if (inCheck && depth < 7) depth++;

    if (depth <= 0) return this.quiescence(alpha, beta, ply);

    const probe = this.ttProbe();
    const ttMove = probe.move;
    if (probe.depth >= depth) {
      let ttScore = probe.score;
      if (ttScore > MATE - 1000) ttScore -= ply;
      else if (ttScore < -MATE + 1000) ttScore += ply;
      if (probe.flag === TT_EXACT) return ttScore;
      if (probe.flag === TT_ALPHA && ttScore <= alpha) return alpha;
      if (probe.flag === TT_BETA && ttScore >= beta) return beta;
    }

    const moves = game.generateMoves(false);
    if (!moves.length) return inCheck ? -MATE + ply : 0;

    this.orderMoves(moves, ttMove, ply);
    const alpha0 = alpha;
    let bestScore = -INF;
    let bestMove = 0;
    let movesSearched = 0;
    this.pvLength[ply] = 0;

    for (const move of moves) {
      const quiet = !(moveFlags(move) & FLAG_CAPTURE) && !movePromotion(move);
      game.makeMove(move);
      let score;
      let reduction = 0;
      if (movesSearched === 0) {
        score = -this.search(depth - 1, -beta, -alpha, ply + 1);
      } else {
        if (depth >= 3 && movesSearched >= 3 && quiet && !inCheck && !game.inCheck()) {
          reduction = 1;
          if (movesSearched >= 7 && depth >= 5) reduction = 2;
        }
        score = -this.search(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && reduction) {
          score = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1);
        }
        if (score > alpha && score < beta) {
          score = -this.search(depth - 1, -beta, -alpha, ply + 1);
        }
      }
      game.unmakeMove();
      movesSearched++;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          this.pv[ply * MAX_PLY] = move;
          const childLen = this.pvLength[ply + 1];
          for (let i = 0; i < childLen; i++) {
            this.pv[ply * MAX_PLY + 1 + i] = this.pv[(ply + 1) * MAX_PLY + i];
          }
          this.pvLength[ply] = childLen + 1;
        }
      }
      if (alpha >= beta) {
        if (quiet) {
          if (this.killers[ply * 2] !== move) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2];
            this.killers[ply * 2] = move;
          }
          const side = game.turn === WHITE ? 0 : 1;
          this.history[side * 16384 + moveFrom(move) * 128 + moveTo(move)] += depth * depth;
        }
        break;
      }
    }

    const flag = bestScore <= alpha0 ? TT_ALPHA : bestScore >= beta ? TT_BETA : TT_EXACT;
    let storeScore = bestScore;
    if (storeScore > MATE - 1000) storeScore += ply;
    else if (storeScore < -MATE + 1000) storeScore -= ply;
    this.ttStore(depth, storeScore, flag, bestMove, probe.idx);
    return bestScore;
  }

  quiescence(alpha, beta, ply) {
    const game = this.game;
    this.nodes++;
    if ((this.nodes & 1023) === 0) this.checkTime();

    const standPat = this.evaluate();
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    if (ply >= MAX_PLY - 2) return standPat;

    const moves = game.generateMoves(true);
    if (!moves.length) return standPat;
    this.orderMoves(moves, 0, ply);

    for (const move of moves) {
      game.makeMove(move);
      const score = -this.quiescence(-beta, -alpha, ply + 1);
      game.unmakeMove();
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /* ----------------------------------- root ----------------------------------- */

  rootSearch(depth, alpha, beta) {
    const game = this.game;
    const moves = game.generateMoves(false);
    if (!moves.length) return null;
    this.orderMoves(moves, this.rootBestMove, 0);
    const alpha0 = alpha;
    let bestScore = -INF;
    let bestMove = 0;
    this.pvLength[0] = 0;

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      game.makeMove(move);
      let score;
      if (i === 0) {
        score = -this.search(depth - 1, -beta, -alpha, 1);
      } else {
        score = -this.search(depth - 1, -alpha - 1, -alpha, 1);
        if (score > alpha && score < beta) {
          score = -this.search(depth - 1, -beta, -alpha, 1);
        }
      }
      game.unmakeMove();

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          this.pv[0] = move;
          const childLen = this.pvLength[1];
          for (let j = 0; j < childLen; j++) this.pv[1 + j] = this.pv[MAX_PLY + j];
          this.pvLength[0] = childLen + 1;
        }
      }
      if (alpha >= beta) break;
    }

    const flag = bestScore <= alpha0 ? TT_ALPHA : bestScore >= beta ? TT_BETA : TT_EXACT;
    const probe = this.ttProbe();
    let storeScore = bestScore;
    if (storeScore > MATE - 1000) storeScore += 0;
    this.ttStore(depth, storeScore, flag, bestMove, probe.idx);
    return { move: bestMove, score: bestScore, pv: this.pvLength[0] ? Array.from(this.pv.slice(0, this.pvLength[0])) : [bestMove] };
  }

  /* ------------------------------- opening book ------------------------------- */

  bookMove(history) {
    const pick = (list) => {
      const legal = list.map((u) => this.game.findMoveByUci(u)).filter(Boolean);
      return legal.length ? legal[Math.floor(Math.random() * legal.length)] : null;
    };
    if (history.length === 0) {
      return pick(['e2e4', 'e2e4', 'd2d4', 'g1f3', 'c2c4']);
    }
    if (history.length === 1) {
      const first = history[0];
      if (first === 'e2e4') return pick(['e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6']);
      if (first === 'd2d4') return pick(['g8f6', 'd7d5', 'e7e6', 'c7c5']);
      if (first === 'g1f3') return pick(['g8f6', 'd7d5', 'c7c5']);
      if (first === 'c2c4') return pick(['e7e5', 'g8f6', 'e7e6']);
      return pick(['e7e5', 'd7d5', 'g8f6']);
    }
    return null;
  }

  /* ---------------------------------- public ---------------------------------- */

  think(options = {}) {
    const config = LEVELS[options.level] || LEVELS[3];
    const maxDepth = Math.max(1, Math.min(30, options.maxDepth || config.maxDepth));
    const timeMs = Math.max(30, options.timeMs || config.timeMs);
    const blunderChance = typeof options.blunder === 'number'
      ? Math.max(0, Math.min(1, options.blunder))
      : config.blunder;
    const game = this.game;
    const history = options.history || [];
    const legal = game.generateMoves(false);
    if (!legal.length) {
      return { move: null, score: 0, depth: 0, nodes: 0, pv: [], time: 0 };
    }

    this.startTime = now();
    this.deadline = this.startTime + timeMs;
    this.nodes = 0;

    const useBook = options.book === true ? true : options.book === false ? false : options.level >= 2;
    let bestMove = 0;
    let bestScore = 0;
    let bestPv = [];
    let completedDepth = 0;
    let bestResult = null;

    const book = useBook ? this.bookMove(history) : null;
    if (book) {
      const result = {
        move: moveToUci(book),
        score: 0,
        depth: 0,
        nodes: 0,
        pv: [moveToUci(book)],
        time: 0,
        book: true,
      };
      return result;
    }

    for (let depth = 1; depth <= maxDepth; depth++) {
      try {
        const result = this.rootSearch(depth, -INF, INF);
        if (!result) break;
        bestResult = result;
        bestMove = result.move;
        bestScore = result.score;
        bestPv = result.pv;
        completedDepth = depth;
        this.rootBestMove = result.move;
        this.rootBestScore = result.score;
        if (Math.abs(result.score) > MATE - 200) break;
        const elapsed = now() - this.startTime;
        if (elapsed > timeMs * 0.5) break;
      } catch (err) {
        if (err !== ABORT) throw err;
        break;
      }
      if (now() >= this.deadline) break;
    }

    if (!bestMove) {
      bestMove = legal[0];
      bestPv = [bestMove];
    }

    // weaker settings occasionally play a random legal move
    if (blunderChance && options.allowBlunder !== false && Math.random() < blunderChance) {
      const alternatives = legal.filter((m) => m !== bestMove);
      if (alternatives.length) {
        bestMove = alternatives[Math.floor(Math.random() * alternatives.length)];
        bestPv = [bestMove];
        bestScore = 0;
      }
    }

    const elapsed = Math.round(now() - this.startTime);
    return {
      move: moveToUci(bestMove),
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      pv: bestPv.map(moveToUci),
      time: elapsed,
      turn: game.turn,
      from: moveFrom(bestMove),
      to: moveTo(bestMove),
      flags: moveFlags(bestMove),
    };
  }
}

/**
 * Build a position from a start FEN plus a list of UCI moves,
 * then run the engine.
 */
export function think({ startFen, moves = [], level = 3, timeMs, maxDepth, blunder, allowBlunder, book } = {}) {
  const game = new Chess(startFen || undefined);
  for (const uci of moves) {
    const move = game.findMoveByUci(uci);
    if (move == null) break;
    game.makeMove(move);
  }
  const engine = new Engine(game);
  const result = engine.think({ level, timeMs, maxDepth, blunder, allowBlunder, book, history: moves });
  return { ...result, fen: game.fen() };
}

export { Engine };
