/* ==========================================================================
   Xadrez Voz + Mesa XY
   --------------------------------------------------------------------------
   Este módulo adiciona a mesa física ao xadrez-voz:
   - conexão Web Serial com o Arduino (Controle_XY.ino);
   - simulação local;
   - planejamento A* com desobstrução e devolução de peças;
   - execução de lances legais do xadrez no tabuleiro físico;
   - traçado do caminho sobre o tabuleiro virtual.
   O jogo, as regras, a IA, o Whisper e a narração continuam no xadrez-voz.
   ========================================================================== */

const CFG = {
  board: { x0: 50, y0: 50, x1: 300, y1: 300 },
  square: 31.25,
  work: 400,
  workMargin: 12,
  gridPerSquare: 20,
  tray: {
    enabled: true,
    side: 'left',
    x: 20,
    y0: 42,
    gap: 31.25,
    slots: 10,
  },
  stepsPerMm: 80,
  baudRate: 115200,
  stepIntervalMs: 0.1,
  gotoTimeoutMs: 45000,
  imaTimeoutMs: 6000,
  zeroTimeoutMs: 10000,
  pickDwellMs: 300,
  releaseDwellMs: 180,
  simImaMs: 160,
  boardBootMs: 2300,
  maxPlanMs: 2600,
  maxPieces: 3,
  maxSearchNodes: 2600,
  maxTempCandidates: 12,
  maxTempDistanceMM: 150,
  maxPathMM: 210,
};

const SQ = CFG.square;
const CELL = SQ / CFG.gridPerSquare;
const NODES = Math.round(CFG.work / CELL) + 1;
const MIN_NODE = Math.ceil(CFG.workMargin / CELL);
const MAX_NODE = Math.floor((CFG.work - CFG.workMargin) / CELL);
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const TRAY_SLOTS = Array.from({ length: CFG.tray.slots }, (_, index) => `t${index + 1}`);
const TRAY_SLOT_RE = /^t(\d+)$/;
const ALL_SQUARES = [];
for (const file of FILES) {
  for (let rank = 1; rank <= 8; rank += 1) ALL_SQUARES.push(file + rank);
}

const PIECE_NAMES = {
  p: 'Peão',
  n: 'Cavalo',
  b: 'Bispo',
  r: 'Torre',
  q: 'Dama',
  k: 'Rei',
};

const PIECE_EASE = { p: 0, n: 8, b: 8, r: 12, q: 16, k: 24 };
const PROMO_LABELS = { 2: 'Cavalo', 3: 'Bispo', 4: 'Torre', 5: 'Dama' };
const ROLE_TEXT = {
  clear: 'DESVIAR',
  target: 'JOGADA',
  restore: 'DEVOLVER',
  discard: 'DESCARTE',
};
const ROLE_COPY = {
  clear: 'sai temporariamente',
  target: 'jogada principal',
  restore: 'volta à casa original',
  discard: 'peça capturada vai para o descarte',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fmt1 = (value) =>
  Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
const fmt2 = (value) =>
  Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const fmtSerial = (value) =>
  Number(value)
    .toFixed(4)
    .replace(/\.?0+$/, '');

function pieceCode(piece) {
  return piece ? `${piece.color}${piece.type.toUpperCase()}` : '';
}

function pieceLabel(piece) {
  if (!piece) return '—';
  return `${PIECE_NAMES[piece.type] || piece.type} · ${piece.color === 'w' ? 'brancas' : 'pretas'}`;
}

function isTraySquare(square) {
  return TRAY_SLOT_RE.test(String(square || ''));
}

function traySlotIndex(square) {
  const match = TRAY_SLOT_RE.exec(String(square || ''));
  return match ? Number(match[1]) - 1 : -1;
}

function traySlotLabel(square) {
  return traySlotIndex(square) >= 0 ? 'descarte' : String(square || '');
}

function traySlotXY(square) {
  const index = Math.max(0, traySlotIndex(square));
  return {
    x: CFG.tray.x,
    y: CFG.tray.y0 + index * CFG.tray.gap,
  };
}

function syncTrayConfig(settings = {}) {
  CFG.tray.enabled = settings.trayEnabled !== false;
  CFG.tray.side = settings.traySide === 'right' ? 'right' : 'left';
  CFG.tray.x = CFG.tray.side === 'right' ? CFG.work - 20 : 20;
}

function freeTraySquares(board) {
  return TRAY_SLOTS.filter((square) => !board[square]);
}

function trayPieceList(board) {
  return TRAY_SLOTS.filter((square) => board[square]).map((slot) => ({
    slot,
    piece: { ...board[slot] },
  }));
}

function parseFEN(fen) {
  const board = {};
  const rows = String(fen).split(' ')[0].split('/');

  rows.forEach((row, index) => {
    const rank = 8 - index;
    let file = 0;

    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }

      board[FILES[file] + rank] = {
        color: ch === ch.toUpperCase() ? 'w' : 'b',
        type: ch.toLowerCase(),
      };
      file += 1;
    }
  });

  return board;
}

function cloneBoard(board) {
  const copy = {};
  for (const [square, piece] of Object.entries(board)) {
    copy[square] = { ...piece };
  }
  return copy;
}

function boardSignature(board) {
  return Object.keys(board)
    .sort()
    .map((square) => `${square}${pieceCode(board[square])}`)
    .join('|');
}

function squareToCell(square, orientation) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  const col = orientation === 'br' || orientation === 'tr' ? 7 - file : file;
  const row = orientation === 'tl' || orientation === 'tr' ? 7 - rank : rank;
  return { col, row };
}

function squareToXY(square, orientation) {
  if (isTraySquare(square)) return traySlotXY(square);

  const { col, row } = squareToCell(square, orientation);
  return {
    x: CFG.board.x0 + (col + 0.5) * SQ,
    y: CFG.board.y0 + (row + 0.5) * SQ,
  };
}

function squareToNode(square, orientation) {
  const point = squareToXY(square, orientation);
  return {
    ix: Math.round(point.x / CELL),
    iy: Math.round(point.y / CELL),
  };
}

function nodeToMM(ix, iy) {
  return {
    x: ix * CELL,
    y: iy * CELL,
  };
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = clamp(
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq,
    0,
    1
  );

  return Math.hypot(
    point.x - (a.x + t * dx),
    point.y - (a.y + t * dy)
  );
}

/* --------------------------------------------------------------------------
   Planejamento A* e desobstrução
   -------------------------------------------------------------------------- */

function clearanceMM(settings) {
  return settings.pieceRadius * 2 + settings.safety;
}

function buildBlockedForBoard(board, excludeSquares, settings) {
  const blocked = new Uint8Array(NODES * NODES);
  const excluded = new Set(excludeSquares);

  for (let y = 0; y < NODES; y += 1) {
    for (let x = 0; x < NODES; x += 1) {
      if (x < MIN_NODE || x > MAX_NODE || y < MIN_NODE || y > MAX_NODE) {
        blocked[y * NODES + x] = 1;
      }
    }
  }

  const clearance = clearanceMM(settings);
  const radiusNodes = clearance / CELL;
  const radiusNodesCeil = Math.ceil(radiusNodes);
  const radiusSq = clearance * clearance;

  for (const [square] of Object.entries(board)) {
    if (excluded.has(square)) continue;

    const center = squareToXY(square, settings.orientation);
    const ci = Math.round(center.x / CELL);
    const cj = Math.round(center.y / CELL);

    const fromX = Math.max(0, ci - radiusNodesCeil);
    const toX = Math.min(NODES - 1, ci + radiusNodesCeil);
    const fromY = Math.max(0, cj - radiusNodesCeil);
    const toY = Math.min(NODES - 1, cj + radiusNodesCeil);

    for (let y = fromY; y <= toY; y += 1) {
      for (let x = fromX; x <= toX; x += 1) {
        const dx = (x - ci) * CELL;
        const dy = (y - cj) * CELL;
        if (dx * dx + dy * dy <= radiusSq) {
          blocked[y * NODES + x] = 1;
        }
      }
    }
  }

  return blocked;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;

    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].f <= items[i].f) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    if (!items.length) return null;

    const top = items[0];
    const last = items.pop();

    if (items.length) {
      items[0] = last;
      let i = 0;

      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;

        if (left < items.length && items[left].f < items[smallest].f) {
          smallest = left;
        }
        if (right < items.length && items[right].f < items[smallest].f) {
          smallest = right;
        }
        if (smallest === i) break;

        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }

    return top;
  }
}

function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

function lineClear(a, b, blocked) {
  const dx = b.ix - a.ix;
  const dy = b.iy - a.iy;

  if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) {
    return false;
  }

  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (!steps) return true;

  const sx = Math.sign(dx);
  const sy = Math.sign(dy);

  for (let step = 1; step <= steps; step += 1) {
    const x = a.ix + sx * step;
    const y = a.iy + sy * step;

    if (blocked[y * NODES + x]) return false;

    if (sx !== 0 && sy !== 0) {
      if (blocked[(a.iy + sy * step) * NODES + (a.ix + sx * (step - 1))]) {
        return false;
      }
      if (blocked[(a.iy + sy * (step - 1)) * NODES + (a.ix + sx * step)]) {
        return false;
      }
    }
  }

  return true;
}

function simplifyPath(nodes, blocked) {
  if (nodes.length <= 2) return nodes;

  const out = [nodes[0]];
  let anchor = 0;

  while (anchor < nodes.length - 1) {
    let best = anchor + 1;

    for (let candidate = nodes.length - 1; candidate > anchor; candidate -= 1) {
      if (lineClear(nodes[anchor], nodes[candidate], blocked)) {
        best = candidate;
        break;
      }
    }

    out.push(nodes[best]);
    anchor = best;
  }

  return out;
}

function planPathForBoard(board, fromSquare, toSquare, settings, cache = null) {
  if (fromSquare === toSquare) {
    return { ok: false, reason: 'A origem e o destino são a mesma casa.' };
  }

  const cacheKey = cache
    ? `${boardSignature(board)}|${fromSquare}|${toSquare}|${settings.orientation}|${settings.pieceRadius}|${settings.safety}|${CFG.tray.enabled}|${CFG.tray.x}|${CFG.tray.y0}|${CFG.tray.gap}`
    : null;

  if (cache && cache.has(cacheKey)) return cache.get(cacheKey);

  const finish = (result) => {
    if (cache && cacheKey) {
      cache.set(cacheKey, result);
      if (cache.size > 1600) cache.clear();
    }
    return result;
  };

  const start = squareToNode(fromSquare, settings.orientation);
  const goal = squareToNode(toSquare, settings.orientation);
  const blocked = buildBlockedForBoard(board, [fromSquare, toSquare], settings);

  const startIndex = start.iy * NODES + start.ix;
  const goalIndex = goal.iy * NODES + goal.ix;

  if (blocked[startIndex]) {
    return finish({
      ok: false,
      reason: 'A peça não tem folga para sair desta casa. Reduza o raio ou a folga.',
    });
  }

  if (blocked[goalIndex]) {
    return finish({
      ok: false,
      reason: 'A casa de destino não tem folga suficiente. Reduza o raio ou a folga.',
    });
  }

  const total = NODES * NODES;
  const gScore = new Float32Array(total);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(total);
  cameFrom.fill(-1);
  const closed = new Uint8Array(total);
  const open = new MinHeap();

  gScore[startIndex] = 0;
  open.push({
    idx: startIndex,
    f: octile(start.ix, start.iy, goal.ix, goal.iy),
  });

  let expanded = 0;
  let found = false;

  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current.idx]) continue;

    const ix = current.idx % NODES;
    const iy = Math.floor(current.idx / NODES);
    const heuristic = octile(ix, iy, goal.ix, goal.iy);

    if (current.f > gScore[current.idx] + heuristic + 1e-4) continue;

    if (current.idx === goalIndex) {
      found = true;
      break;
    }

    closed[current.idx] = 1;
    expanded += 1;

    for (let dir = 0; dir < 8; dir += 1) {
      const nx = ix + dx[dir];
      const ny = iy + dy[dir];

      if (nx < 0 || nx >= NODES || ny < 0 || ny >= NODES) continue;

      const nextIndex = ny * NODES + nx;
      if (blocked[nextIndex] || closed[nextIndex]) continue;

      const diagonal = dx[dir] !== 0 && dy[dir] !== 0;
      if (diagonal && (blocked[iy * NODES + nx] || blocked[ny * NODES + ix])) {
        continue;
      }

      const stepCost = diagonal ? Math.SQRT2 : 1;
      const tentative = gScore[current.idx] + stepCost;

      if (tentative + 1e-9 < gScore[nextIndex]) {
        gScore[nextIndex] = tentative;
        cameFrom[nextIndex] = current.idx;
        open.push({
          idx: nextIndex,
          f: tentative + octile(nx, ny, goal.ix, goal.iy),
        });
      }
    }
  }

  if (!found) {
    return finish({
      ok: false,
      reason: 'Sem rota livre: as peças bloqueiam a passagem.',
      expanded,
    });
  }

  const raw = [];
  let cursor = goalIndex;

  while (cursor !== -1) {
    raw.push({ ix: cursor % NODES, iy: Math.floor(cursor / NODES) });
    cursor = cameFrom[cursor];
  }

  raw.reverse();
  const simplified = simplifyPath(raw, blocked);

  const points = simplified.map((node) => ({
    ...nodeToMM(node.ix, node.iy),
    ix: node.ix,
    iy: node.iy,
  }));

  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
  }

  return finish({
    ok: true,
    points,
    length,
    expanded,
    clearance: clearanceMM(settings),
  });
}

function boardWithMove(board, fromSquare, toSquare) {
  const next = cloneBoard(board);
  const piece = next[fromSquare];
  delete next[fromSquare];
  delete next[toSquare];
  next[toSquare] = piece;
  return next;
}

function applyMovesToBoard(board, moves) {
  let current = cloneBoard(board);
  for (const move of moves) {
    current = boardWithMove(current, move.from, move.to);
  }
  return current;
}

function applyCaptureMoves(board, moves) {
  let current = cloneBoard(board);
  for (const move of moves) {
    if (move.role === 'discard') {
      delete current[move.from];
    } else {
      current = boardWithMove(current, move.from, move.to);
    }
  }
  return current;
}

function makePlanMove(board, fromSquare, toSquare, role, originalSquare, path, settings) {
  return {
    from: fromSquare,
    to: toSquare,
    role,
    piece: { ...board[fromSquare] },
    originalSquare: role === 'target' ? null : originalSquare,
    path: {
      points: path.points,
      length: path.length,
      expanded: path.expanded,
      clearance: path.clearance,
      segments: Math.max(1, path.points.length - 1),
    },
    start: squareToXY(fromSquare, settings.orientation),
    drop: squareToXY(toSquare, settings.orientation),
  };
}

function finalizePlan(moves, blockers, targetFrom, targetTo, settings) {
  const targetMove = moves.find((move) => move.role === 'target');
  const totalLength = moves.reduce((sum, move) => sum + move.path.length, 0);
  const totalSegments = moves.reduce((sum, move) => sum + move.path.segments, 0);
  const totalExpanded = moves.reduce((sum, move) => sum + move.path.expanded, 0);
  const typePenalty =
    blockers.reduce(
      (sum, blocker) => sum + (PIECE_EASE[blocker.piece.type] || 0),
      0
    ) * 4;

  return {
    ok: true,
    kind: blockers.length ? 'rearrange' : 'direct',
    from: targetFrom,
    to: targetTo,
    moves,
    targetMove,
    targetIndex: moves.indexOf(targetMove),
    blockers,
    totalLength,
    totalSegments,
    totalExpanded,
    totalSteps: moves.length,
    clearance: clearanceMM(settings),
    cost: totalLength + moves.length * 25 + typePenalty,
  };
}

function getTempCandidates(board, fromSquare, reserved, targetTo, settings, cache, deadline) {
  const origin = squareToXY(fromSquare, settings.orientation);
  const targetPoint = squareToXY(targetTo, settings.orientation);
  const candidates = [];

  for (const square of ALL_SQUARES) {
    if (performance.now() > deadline) break;
    if (board[square] || reserved.has(square)) continue;

    const point = squareToXY(square, settings.orientation);
    if (Math.hypot(point.x - origin.x, point.y - origin.y) > CFG.maxTempDistanceMM) {
      continue;
    }

    const path = planPathForBoard(board, fromSquare, square, settings, cache);
    if (!path.ok || path.length > CFG.maxPathMM) continue;

    let nearPieces = 0;
    for (const occupied of Object.keys(board)) {
      const other = squareToXY(occupied, settings.orientation);
      if (Math.hypot(point.x - other.x, point.y - other.y) < SQ * 2) {
        nearPieces += 1;
      }
    }

    let score = path.length + nearPieces * 9;
    if (Math.hypot(point.x - targetPoint.x, point.y - targetPoint.y) < SQ * 2) {
      score += 35;
    }

    candidates.push({ square, path, score });
  }

  candidates.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return candidates.slice(0, CFG.maxTempCandidates);
}

function searchRestores(board, moved, settings, cache, timeUp) {
  if (timeUp()) return null;
  if (!moved.length) return [];

  const ordered = [...moved].sort((a, b) => {
    const da = Math.hypot(
      squareToXY(a.temp, settings.orientation).x - squareToXY(a.square, settings.orientation).x,
      squareToXY(a.temp, settings.orientation).y - squareToXY(a.square, settings.orientation).y
    );
    const db = Math.hypot(
      squareToXY(b.temp, settings.orientation).x - squareToXY(b.square, settings.orientation).x,
      squareToXY(b.temp, settings.orientation).y - squareToXY(b.square, settings.orientation).y
    );
    return da - db;
  });

  for (const item of ordered) {
    if (timeUp()) break;

    const path = planPathForBoard(board, item.temp, item.square, settings, cache);
    if (!path.ok) continue;

    const move = makePlanMove(
      board,
      item.temp,
      item.square,
      'restore',
      item.square,
      path,
      settings
    );
    const nextBoard = boardWithMove(board, item.temp, item.square);
    const rest = searchRestores(
      nextBoard,
      moved.filter((candidate) => candidate !== item),
      settings,
      cache,
      timeUp
    );

    if (rest) return [move, ...rest];
  }

  return null;
}

function tryRelocationSet(
  baseBoard,
  blockerSquares,
  targetFrom,
  targetTo,
  settings,
  deadline,
  cache,
  globalTimeUp,
  forbidden
) {
  const blockers = blockerSquares.map((square) => ({
    square,
    piece: { ...baseBoard[square] },
  }));
  const reserved = new Set([
    targetFrom,
    targetTo,
    ...blockerSquares,
    ...forbidden,
  ]);

  let nodes = 0;
  let best = null;

  const timeUp = () =>
    globalTimeUp() ||
    performance.now() > deadline ||
    nodes > CFG.maxSearchNodes;

  function relocate(board, remaining, moved, clearMoves) {
    if (timeUp()) return;
    nodes += 1;

    if (!remaining.length) {
      const targetPath = planPathForBoard(
        board,
        targetFrom,
        targetTo,
        settings,
        cache
      );
      if (!targetPath.ok) return;

      const targetMove = makePlanMove(
        board,
        targetFrom,
        targetTo,
        'target',
        null,
        targetPath,
        settings
      );
      const afterTarget = boardWithMove(board, targetFrom, targetTo);
      const restoreMoves = searchRestores(
        afterTarget,
        moved,
        settings,
        cache,
        timeUp
      );
      if (!restoreMoves) return;

      const moves = [...clearMoves, targetMove, ...restoreMoves];

      const expected = cloneBoard(baseBoard);
      const targetPiece = expected[targetFrom];
      delete expected[targetFrom];
      expected[targetTo] = targetPiece;

      const finalBoard = applyMovesToBoard(baseBoard, moves);
      if (boardSignature(finalBoard) !== boardSignature(expected)) return;

      const movedBlockers = moved.map((item) => ({
        square: item.square,
        temp: item.temp,
        piece: { ...item.piece },
      }));
      const solution = finalizePlan(
        moves,
        movedBlockers,
        targetFrom,
        targetTo,
        settings
      );

      if (!best || solution.cost < best.cost) best = solution;
      return;
    }

    const ordered = [...remaining].sort((a, b) => {
      const easeA = PIECE_EASE[a.piece.type] || 0;
      const easeB = PIECE_EASE[b.piece.type] || 0;
      return easeA - easeB || a.square.localeCompare(b.square);
    });

    for (const blocker of ordered) {
      if (timeUp()) break;

      const candidates = getTempCandidates(
        board,
        blocker.square,
        reserved,
        targetTo,
        settings,
        cache,
        deadline
      );

      for (const candidate of candidates) {
        if (timeUp()) break;

        const clearMove = makePlanMove(
          board,
          blocker.square,
          candidate.square,
          'clear',
          blocker.square,
          candidate.path,
          settings
        );
        const nextBoard = boardWithMove(
          board,
          blocker.square,
          candidate.square
        );
        const item = {
          square: blocker.square,
          temp: candidate.square,
          piece: { ...blocker.piece },
        };

        relocate(
          nextBoard,
          remaining.filter((other) => other !== blocker),
          [...moved, item],
          [...clearMoves, clearMove]
        );
      }
    }
  }

  relocate(cloneBoard(baseBoard), blockers, [], []);
  return best;
}

function localRearrangementCandidates(board, targetFrom, targetTo, settings, forbidden) {
  const a = squareToXY(targetFrom, settings.orientation);
  const b = squareToXY(targetTo, settings.orientation);
  const maxDistance = SQ * 4;

  return Object.keys(board)
    .filter(
      (square) =>
        !isTraySquare(square) &&
        square !== targetFrom &&
        square !== targetTo &&
        !forbidden.has(square)
    )
    .map((square) => {
      const point = squareToXY(square, settings.orientation);
      const d = Math.min(
        pointSegmentDistance(point, a, b),
        Math.hypot(point.x - a.x, point.y - a.y),
        Math.hypot(point.x - b.x, point.y - b.y)
      );
      return { square, distance: d };
    })
    .filter((item) => item.distance <= maxDistance)
    .sort((x, y) => x.distance - y.distance)
    .slice(0, 16)
    .map((item) => item.square);
}

function combinationsOf(items, size) {
  const result = [];

  function walk(start, combo) {
    if (combo.length === size) {
      result.push(combo.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      combo.push(items[i]);
      walk(i + 1, combo);
      combo.pop();
    }
  }

  walk(0, []);
  return result;
}

function chooseBestSolution(solutions) {
  return [...solutions].sort((a, b) => a.cost - b.cost)[0] || null;
}

function searchRearrangement(
  board,
  targetFrom,
  targetTo,
  settings,
  started,
  cache,
  forbidden
) {
  const globalTimeUp = () => performance.now() - started > CFG.maxPlanMs;

  const allPieces = Object.keys(board).filter(
    (square) =>
      !isTraySquare(square) &&
      square !== targetFrom &&
      square !== targetTo &&
      !forbidden.has(square)
  );

  const singleSolutions = [];

  for (const square of allPieces) {
    if (globalTimeUp()) break;

    const without = cloneBoard(board);
    delete without[square];

    const possible = planPathForBoard(
      without,
      targetFrom,
      targetTo,
      settings,
      cache
    );
    if (!possible.ok) continue;

    const solution = tryRelocationSet(
      board,
      [square],
      targetFrom,
      targetTo,
      settings,
      started + CFG.maxPlanMs,
      cache,
      globalTimeUp,
      forbidden
    );
    if (solution) singleSolutions.push(solution);
  }

  if (singleSolutions.length) return chooseBestSolution(singleSolutions);
  if (globalTimeUp()) {
    return {
      ok: false,
      reason: 'O cálculo da desobstrução atingiu o tempo limite.',
    };
  }

  const local = localRearrangementCandidates(
    board,
    targetFrom,
    targetTo,
    settings,
    forbidden
  );

  for (let size = 2; size <= CFG.maxPieces; size += 1) {
    if (globalTimeUp()) break;

    const solutions = [];

    for (const combo of combinationsOf(local, size)) {
      if (globalTimeUp()) break;

      const without = cloneBoard(board);
      for (const square of combo) delete without[square];

      const possible = planPathForBoard(
        without,
        targetFrom,
        targetTo,
        settings,
        cache
      );
      if (!possible.ok) continue;

      const solution = tryRelocationSet(
        board,
        combo,
        targetFrom,
        targetTo,
        settings,
        started + CFG.maxPlanMs,
        cache,
        globalTimeUp,
        forbidden
      );
      if (solution) solutions.push(solution);
      if (solutions.length >= 6) break;
    }

    if (solutions.length) return chooseBestSolution(solutions);
  }

  return {
    ok: false,
    reason:
      'Não encontrei uma desobstrução segura com até 3 peças. ' +
      'Reduza a folga ou remova uma peça manualmente.',
  };
}

function buildMovePlan(board, targetFrom, targetTo, settings, options = {}) {
  const forbidden = new Set(options.forbiddenSquares || []);

  if (targetFrom === targetTo) {
    return { ok: false, reason: 'Origem e destino são a mesma casa.' };
  }
  if (!board[targetFrom]) {
    return { ok: false, reason: 'Não há peça na casa de origem.' };
  }
  if (board[targetTo]) {
    return { ok: false, reason: 'A casa de destino está ocupada.' };
  }

  const cache = new Map();
  const direct = planPathForBoard(
    board,
    targetFrom,
    targetTo,
    settings,
    cache
  );

  if (direct.ok) {
    const targetMove = makePlanMove(
      board,
      targetFrom,
      targetTo,
      'target',
      null,
      direct,
      settings
    );
    return finalizePlan([targetMove], [], targetFrom, targetTo, settings);
  }

  const started = performance.now();
  const result = searchRearrangement(
    board,
    targetFrom,
    targetTo,
    settings,
    started,
    cache,
    forbidden
  );

  if (result.ok) return result;
  return {
    ok: false,
    reason:
      result.reason ||
      'Não foi possível encontrar um plano físico para essa jogada.',
  };
}

function chooseTraySquare(board, capturedSquare, settings) {
  const free = freeTraySquares(board);
  if (!free.length) return null;

  const origin = squareToXY(capturedSquare, settings.orientation);
  return free
    .map((slot) => {
      const point = squareToXY(slot, settings.orientation);
      return {
        slot,
        distance: Math.hypot(point.x - origin.x, point.y - origin.y),
      };
    })
    .sort((a, b) => a.distance - b.distance)[0].slot;
}

function buildCapturePlan(board, info, settings) {
  const capturedSquare = info.capturedSquare || info.to;
  const captured = board[capturedSquare];

  if (!captured) {
    return {
      ok: false,
      reason: `A peça capturada não está em ${capturedSquare} no modelo físico.`,
    };
  }

  const traySquare = chooseTraySquare(board, capturedSquare, settings);

  if (!traySquare) {
    return {
      ok: false,
      reason: 'Não foi possível escolher um ponto de descarte.',
    };
  }

  const discardPath = planPathForBoard(
    board,
    capturedSquare,
    traySquare,
    settings
  );

  if (!discardPath.ok) {
    return {
      ok: false,
      reason: `Não há rota livre para levar a peça capturada até o descarte. ${discardPath.reason}`,
    };
  }

  const discardMove = makePlanMove(
    board,
    capturedSquare,
    traySquare,
    'discard',
    capturedSquare,
    discardPath,
    settings
  );
  discardMove.label = 'Capturada';

  const afterDiscard = cloneBoard(board);
  delete afterDiscard[capturedSquare];

  const targetPlan = buildMovePlan(
    afterDiscard,
    info.from,
    info.to,
    settings
  );

  if (!targetPlan.ok) {
    return {
      ok: false,
      reason: `A peça capturada sairia, mas a jogada não tem rota livre. ${targetPlan.reason}`,
    };
  }

  const moves = [discardMove, ...targetPlan.moves];

  const expected = cloneBoard(afterDiscard);
  const moving = expected[info.from];
  delete expected[info.from];
  expected[info.to] = moving;

  const finalBoard = applyCaptureMoves(board, moves);
  if (boardSignature(finalBoard) !== boardSignature(expected)) {
    return {
      ok: false,
      reason: 'O plano da captura não terminou na posição física esperada.',
    };
  }

  const totalLength = moves.reduce((sum, move) => sum + move.path.length, 0);
  const totalSegments = moves.reduce(
    (sum, move) => sum + move.path.segments,
    0
  );
  const totalExpanded = moves.reduce(
    (sum, move) => sum + move.path.expanded,
    0
  );

  return {
    ok: true,
    kind: 'capture',
    from: info.from,
    to: info.to,
    moves,
    targetMove: targetPlan.targetMove,
    targetIndex: moves.indexOf(targetPlan.targetMove),
    blockers: targetPlan.blockers || [],
    captured: {
      square: capturedSquare,
      tray: traySquare,
      piece: { ...captured },
    },
    traySquare,
    totalLength,
    totalSegments,
    totalExpanded,
    totalSteps: moves.length,
    clearance: clearanceMM(settings),
    cost:
      totalLength +
      moves.length * 25 +
      (targetPlan.blockers || []).reduce(
        (sum, blocker) => sum + (PIECE_EASE[blocker.piece.type] || 0) * 4,
        0
      ),
  };
}

function buildCastlePlan(board, info, settings) {
  const rank = info.color === 'w' ? '1' : '8';
  const kingFrom = `e${rank}`;
  const kingTo = info.kcastle ? `g${rank}` : `c${rank}`;
  const rookFrom = info.kcastle ? `h${rank}` : `a${rank}`;
  const rookTo = info.kcastle ? `f${rank}` : `d${rank}`;

  if (!board[kingFrom] || !board[rookFrom]) return null;

  const orders = [
    { first: 'king', second: 'rook' },
    { first: 'rook', second: 'king' },
  ];

  for (const order of orders) {
    let working = cloneBoard(board);
    let firstPlan = null;
    let secondPlan = null;

    if (order.first === 'king') {
      firstPlan = buildMovePlan(working, kingFrom, kingTo, settings, {
        forbiddenSquares: [rookFrom, rookTo],
      });
      if (!firstPlan.ok) continue;
      working = applyMovesToBoard(working, firstPlan.moves);
      secondPlan = buildMovePlan(working, rookFrom, rookTo, settings, {
        forbiddenSquares: [kingFrom, kingTo],
      });
      if (!secondPlan.ok) continue;
    } else {
      firstPlan = buildMovePlan(working, rookFrom, rookTo, settings, {
        forbiddenSquares: [kingFrom, kingTo],
      });
      if (!firstPlan.ok) continue;
      working = applyMovesToBoard(working, firstPlan.moves);
      secondPlan = buildMovePlan(working, kingFrom, kingTo, settings, {
        forbiddenSquares: [rookFrom, rookTo],
      });
      if (!secondPlan.ok) continue;
    }

    const moves = [...firstPlan.moves, ...secondPlan.moves];
    const expected = cloneBoard(board);
    const king = expected[kingFrom];
    const rook = expected[rookFrom];
    delete expected[kingFrom];
    delete expected[rookFrom];
    expected[kingTo] = king;
    expected[rookTo] = rook;

    const finalBoard = applyMovesToBoard(board, moves);
    if (boardSignature(finalBoard) !== boardSignature(expected)) continue;

    firstPlan.targetMove.label = 'Rei';
    secondPlan.targetMove.label = 'Torre';

    const blockers = [...firstPlan.blockers, ...secondPlan.blockers];
    const totalLength = moves.reduce((sum, move) => sum + move.path.length, 0);
    const totalSegments = moves.reduce(
      (sum, move) => sum + move.path.segments,
      0
    );
    const totalExpanded = moves.reduce(
      (sum, move) => sum + move.path.expanded,
      0
    );

    return {
      ok: true,
      kind: 'castle',
      from: kingFrom,
      to: kingTo,
      moves,
      blockers,
      targetMoves: [firstPlan.targetMove, secondPlan.targetMove],
      totalLength,
      totalSegments,
      totalExpanded,
      totalSteps: moves.length,
      clearance: clearanceMM(settings),
    };
  }

  return null;
}

/* --------------------------------------------------------------------------
   Comunicação com o Arduino / simulação
   -------------------------------------------------------------------------- */

class MachineStopError extends Error {
  constructor(message = 'Movimento interrompido.') {
    super(message);
    this.name = 'MachineStopError';
  }
}

class SerialMachine {
  constructor(sink) {
    this.sink = sink;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.active = false;
    this.closing = false;
    this.magnet = false;
    this.magnetConfirmed = false;
    this.writeChain = Promise.resolve();
    this.pendingGoto = null;
    this.pendingIma = null;
    this.pendingZero = null;
  }

  log(direction, text) {
    this.sink.onLine?.(direction, text);
  }

  async connect() {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial não está disponível. Use Chrome ou Edge.');
    }

    this.sink.onStatus?.('Escolha a porta do Arduino...');
    this.port = await navigator.serial.requestPort();

    this.sink.onStatus?.('Abrindo a porta serial...');
    await this.port.open({ baudRate: CFG.baudRate });

    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.active = true;

    this.readLoop().catch((error) => {
      if (!this.closing) this.fail(error);
    });

    this.sink.onStatus?.('Aguardando o Arduino iniciar...');
    await delay(CFG.boardBootMs);

    try {
      await this.send('STOP');
      await delay(80);
    } catch (error) {
      this.log('err', `Falha no STOP inicial: ${error.message}`);
    }

    try {
      await this.ima(false, 3000);
    } catch (error) {
      this.log('err', `Sem confirmação do IMA após o boot: ${error.message}`);
    }

    try {
      await this.send('POS');
    } catch (error) {
      this.log('err', `Falha ao pedir POS: ${error.message}`);
    }

    this.sink.onStatus?.('Conectado.');
  }

  async readLoop() {
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.active) {
        const { value, done } = await this.reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const line = raw.replace(/\r/g, '').trim();
          if (line) this.handleLine(line);
        }
      }

      if (!this.closing && this.active) {
        throw new Error('Conexão serial encerrada pelo dispositivo.');
      }
    } catch (error) {
      if (!this.closing) {
        this.fail(
          error.name === 'NetworkError'
            ? new Error('O Arduino foi desconectado.')
            : error
        );
      }
    } finally {
      if (!this.closing) this.active = false;
    }
  }

  handleLine(line) {
    this.log('rx', line);

    if (line.startsWith('POS,')) {
      const [, rawX, rawY] = line.split(',');
      const x = Number(rawX) / CFG.stepsPerMm;
      const y = Number(rawY) / CFG.stepsPerMm;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        this.sink.onPos?.(x, y);
      }
      return;
    }

    if (line === 'MOVENDO') {
      this.sink.onStatus?.('Movendo...');
      return;
    }

    if (line === 'DONE') {
      this.resolveGoto();
      return;
    }

    if (line === 'STOPPED') {
      this.rejectGoto(
        new MachineStopError('Movimento interrompido pelo operador.')
      );
      return;
    }

    if (line.startsWith('IMA,')) {
      const on = line.slice(4).trim() === '1';
      this.magnet = on;
      this.magnetConfirmed = true;
      this.sink.onMagnet?.(on);
      this.resolveIma(on);
      return;
    }

    if (line === 'ZERO_OK') {
      this.sink.onPos?.(0, 0);
      this.resolveZero();
      return;
    }

    if (line === 'PRONTO') {
      this.sink.onStatus?.('Arduino pronto.');
      return;
    }

    if (line.startsWith('ERRO')) {
      const message = line.replace(/^ERRO,?/, '').trim() || line;
      const error = new Error(`Arduino: ${message}`);
      this.rejectGoto(error);
      this.rejectIma(error);
      this.rejectZero(error);
      this.sink.onError?.(error);
    }
  }

  async send(command) {
    if (!this.active || !this.writer) {
      throw new Error('Porta serial não está aberta.');
    }

    const encoder = new TextEncoder();
    const run = this.writeChain
      .catch(() => {})
      .then(async () => {
        await this.writer.write(encoder.encode(`${command}\n`));
        this.log('tx', command);
      });

    this.writeChain = run.catch(() => {});
    return run;
  }

  async goto(x, y, timeout = CFG.gotoTimeoutMs) {
    if (this.pendingGoto) {
      throw new Error('Já existe um GOTO em execução.');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingGoto) return;
        this.pendingGoto = null;
        this.send('STOP').catch(() => {});
        reject(new Error('Tempo esgotado aguardando DONE do Arduino.'));
      }, timeout);

      this.pendingGoto = {
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingGoto = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pendingGoto = null;
          reject(error);
        },
      };

      this.send(`GOTO,${fmtSerial(x)},${fmtSerial(y)}`).catch((error) => {
        this.rejectGoto(error);
      });
    });
  }

  async ima(on, timeout = CFG.imaTimeoutMs) {
    if (this.pendingIma) {
      throw new Error('Já existe um comando de ímã em execução.');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingIma) return;
        this.pendingIma = null;
        reject(new Error(`Tempo esgotado aguardando IMA,${on ? 1 : 0}.`));
      }, timeout);

      this.pendingIma = {
        requested: on,
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingIma = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pendingIma = null;
          reject(error);
        },
      };

      this.send(`IMA,${on ? 1 : 0}`).catch((error) => {
        this.rejectIma(error);
      });
    });
  }

  async zero(timeout = CFG.zeroTimeoutMs) {
    if (this.pendingZero) {
      throw new Error('Já existe um comando ZERO em execução.');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingZero) return;
        this.pendingZero = null;
        reject(new Error('Tempo esgotado aguardando ZERO_OK.'));
      }, timeout);

      this.pendingZero = {
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingZero = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pendingZero = null;
          reject(error);
        },
      };

      this.send('ZERO').catch((error) => {
        this.rejectZero(error);
      });
    });
  }

  async stop() {
    return this.send('STOP');
  }

  async forceMagnetOff() {
    return this.send('IMA,0');
  }

  resolveGoto() {
    if (this.pendingGoto) this.pendingGoto.resolve();
  }

  rejectGoto(error) {
    if (this.pendingGoto) this.pendingGoto.reject(error);
  }

  resolveIma(actual) {
    if (!this.pendingIma) return;

    if (actual === this.pendingIma.requested) {
      this.pendingIma.resolve(actual);
    } else {
      this.pendingIma.reject(
        new Error(
          `Arduino respondeu IMA,${actual ? 1 : 0} quando se esperava IMA,${this.pendingIma.requested ? 1 : 0}.`
        )
      );
    }
  }

  rejectIma(error) {
    if (this.pendingIma) this.pendingIma.reject(error);
  }

  resolveZero() {
    if (this.pendingZero) this.pendingZero.resolve();
  }

  rejectZero(error) {
    if (this.pendingZero) this.pendingZero.reject(error);
  }

  fail(error) {
    this.rejectGoto(error);
    this.rejectIma(error);
    this.rejectZero(error);
    this.sink.onError?.(error);
    this.sink.onDisconnect?.(error);
  }

  async disconnect() {
    this.closing = true;

    if (this.magnet && this.active) {
      try {
        await this.ima(false, 2500);
      } catch {
        /* sem confirmação */
      }
    }

    this.active = false;
    this.rejectGoto(new Error('Desconectado.'));
    this.rejectIma(new Error('Desconectado.'));
    this.rejectZero(new Error('Desconectado.'));

    try {
      await this.reader?.cancel();
    } catch {}
    try {
      this.reader?.releaseLock();
    } catch {}
    try {
      this.writer?.releaseLock();
    } catch {}
    try {
      await this.port?.close();
    } catch {}

    this.reader = null;
    this.writer = null;
    this.port = null;
  }
}

class SimMachine {
  constructor(sink) {
    this.sink = sink;
    this.active = false;
    this.pos = { x: 0, y: 0 };
    this.magnet = false;
    this.pending = null;
    this.timer = null;
  }

  async connect() {
    this.active = true;
    this.pos = { x: 0, y: 0 };
    this.magnet = false;
    this.sink.onStatus?.('Simulação ativa.');
    this.sink.onPos?.(0, 0);
    this.sink.onMagnet?.(false);
    await delay(250);
  }

  goto(x, y) {
    if (!this.active) return Promise.reject(new Error('Simulação desconectada.'));
    if (this.pending) {
      return Promise.reject(new Error('Já existe um movimento em andamento.'));
    }
    if (x < 0 || x > 400 || y < 0 || y > 400) {
      return Promise.reject(new Error('Coordenada fora dos limites.'));
    }

    return new Promise((resolve, reject) => {
      const from = { ...this.pos };
      const dx = x - from.x;
      const dy = y - from.y;
      const stepsX = Math.abs(Math.round(dx * CFG.stepsPerMm));
      const stepsY = Math.abs(Math.round(dy * CFG.stepsPerMm));
      const maxSteps = Math.max(stepsX, stepsY, 1);
      const duration = Math.max(140, maxSteps * CFG.stepIntervalMs);
      const started = performance.now();

      const finish = (error) => {
        if (!this.pending) return;
        const current = this.pending;
        this.pending = null;
        clearInterval(this.timer);
        clearTimeout(current.fallback);
        if (error) {
          current.reject(error);
        } else {
          this.pos = { x, y };
          this.sink.onPos?.(x, y);
          current.resolve();
        }
      };

      this.pending = {
        resolve,
        reject,
        fallback: setTimeout(() => finish(null), duration + 8000),
      };

      this.timer = setInterval(() => {
        if (!this.pending) return;

        const t = Math.min(1, (performance.now() - started) / duration);
        const progressSteps = maxSteps * t;
        const progressX = Math.min(stepsX, progressSteps) / CFG.stepsPerMm;
        const progressY = Math.min(stepsY, progressSteps) / CFG.stepsPerMm;
        const nx = from.x + Math.sign(dx) * progressX;
        const ny = from.y + Math.sign(dy) * progressY;

        this.pos = { x: nx, y: ny };
        this.sink.onPos?.(nx, ny);

        if (t >= 1) finish(null);
      }, 28);
    });
  }

  async ima(on) {
    if (!this.active) throw new Error('Simulação desconectada.');
    await delay(CFG.simImaMs);
    this.magnet = on;
    this.sink.onMagnet?.(on);
  }

  async zero() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearInterval(this.timer);
      clearTimeout(pending.fallback);
      pending.reject(new MachineStopError('Movimento cancelado pelo ZERO.'));
    }
    this.pos = { x: 0, y: 0 };
    this.sink.onPos?.(0, 0);
    await delay(100);
  }

  async stop() {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearInterval(this.timer);
    clearTimeout(pending.fallback);
    pending.reject(new MachineStopError('Movimento interrompido pelo operador.'));
  }

  async forceMagnetOff() {
    this.magnet = false;
    this.sink.onMagnet?.(false);
  }

  async disconnect() {
    this.active = false;
    if (this.pending) {
      await this.stop();
    }
    this.magnet = false;
    this.sink.onMagnet?.(false);
  }
}

/* --------------------------------------------------------------------------
   Interface e estado da mesa
   -------------------------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SETTINGS_KEY = 'xvoz.xy.settings.v1';

const PANEL_TEMPLATE = `
<div class="xy-panel">
  <div class="xy-panel-head">
    <div>
      <b>Mesa XY</b>
      <small id="xyConnText">Jogo apenas na tela.</small>
    </div>
    <span class="xy-dot" id="xyDot"></span>
  </div>

  <div class="segmented" id="xyMode">
    <button type="button" data-xy-mode="serial" class="active">Arduino</button>
    <button type="button" data-xy-mode="sim">Simulação</button>
  </div>

  <div class="xy-actions">
    <button class="btn primary compact" id="xyConnect" type="button">Conectar Arduino</button>
    <button class="btn compact" id="xyDisconnect" type="button" hidden>Desconectar</button>
  </div>

  <p class="hint" id="xyConnHint">
    Conecte a mesa para os lances legais serem executados fisicamente.
  </p>

  <div class="xy-grid">
    <div class="xy-value">
      <small>Posição X</small>
      <b><span id="xyX">0,00</span> <span>mm</span></b>
    </div>
    <div class="xy-value">
      <small>Posição Y</small>
      <b><span id="xyY">0,00</span> <span>mm</span></b>
    </div>
  </div>

  <div class="xy-badges">
    <span class="xy-badge" id="xyMagnet">Ímã desligado</span>
    <span class="xy-badge" id="xyOrigin">Origem não confirmada</span>
    <span class="xy-badge" id="xySyncState">Mesa não sincronizada</span>
  </div>

  <div class="xy-actions">
    <button class="btn compact" id="xyZero" type="button">Confirmar origem</button>
    <button class="btn compact" id="xyHome" type="button">Ir para 0,0</button>
    <button class="btn compact" id="xyMagnetOff" type="button">Ímã OFF</button>
    <button class="btn compact danger" id="xyStop" type="button">PARAR</button>
  </div>

  <div class="xy-enable">
    <label class="toggle-row" for="xyEnabled">
      <span>
        <b>Executar no tabuleiro físico</b>
        <small>Desligue para jogar apenas na tela.</small>
      </span>
      <input type="checkbox" id="xyEnabled" checked>
      <span class="switch" aria-hidden="true"></span>
    </label>
  </div>

  <div class="xy-sync">
    <button class="btn compact" id="xySyncBtn" type="button">
      Confirmar mesa sincronizada
    </button>
  </div>

  <div id="xyDanger"></div>
  <div id="xyPromo"></div>

  <div class="xy-plan" id="xyPlan">
    <div class="xy-plan-head">
      <b>Plano físico</b>
      <span id="xyPlanCount">—</span>
    </div>
    <p class="hint" id="xyPhase" style="margin:0 0 6px;"></p>
    <ol class="xy-plan-list" id="xyPlanList">
      <li class="xy-empty">Nenhum movimento físico em andamento.</li>
    </ol>
  </div>

  <div class="xy-legend" aria-label="Legenda do traçado">
    <span><i class="target"></i>Jogada</span>
    <span><i class="clear"></i>Desvio</span>
    <span><i class="restore"></i>Devolução</span>
    <span><i class="discard"></i>Descarte</span>
  </div>

  <div class="xy-log" id="xyLog"></div>

  <details class="xy-settings">
    <summary>Ajustes da mesa</summary>

    <div class="xy-setting">
      <label class="toggle-row" for="xyTrayEnabled">
        <span>
          <b>Descarte automático de capturas</b>
          <small>Levar a peça capturada para fora e considerá-la retirada.</small>
        </span>
        <input type="checkbox" id="xyTrayEnabled" checked>
        <span class="switch" aria-hidden="true"></span>
      </label>
    </div>

    <div class="xy-setting">
      <label for="xyTraySide">Lado do descarte</label>
      <select id="xyTraySide">
        <option value="left">Esquerda da mesa (padrão)</option>
        <option value="right">Direita da mesa</option>
      </select>
    </div>

    <div class="xy-setting">
      <label for="xyOrientation">Canto físico do a1</label>
      <select id="xyOrientation">
        <option value="bl">Inferior esquerdo (padrão)</option>
        <option value="br">Inferior direito</option>
        <option value="tl">Superior esquerdo</option>
        <option value="tr">Superior direito</option>
      </select>
    </div>

    <div class="xy-setting">
      <label for="xyRadius">
        Raio da base da peça
        <span class="xy-setting-value" id="xyRadiusOut">8,0 mm</span>
      </label>
      <input type="range" id="xyRadius" min="3" max="15" step="0.5" value="8">
    </div>

    <div class="xy-setting">
      <label for="xySafety">
        Folga de segurança
        <span class="xy-setting-value" id="xySafetyOut">2,0 mm</span>
      </label>
      <input type="range" id="xySafety" min="0" max="8" step="0.5" value="2">
    </div>

    <div class="xy-setting">
      <label>Mover manualmente</label>
      <div class="xy-grid">
        <input type="number" id="xyManualX" min="0" max="400" step="0.1" value="0" placeholder="X mm">
        <input type="number" id="xyManualY" min="0" max="400" step="0.1" value="0" placeholder="Y mm">
      </div>
      <button class="btn compact" id="xyManualGo" type="button">Mover com ímã desligado</button>
    </div>

    <p class="hint">
      A mesa física é a mesma do Controle_XY: área de trabalho de 0 a 400 mm,
      tabuleiro de 50 a 300 mm, origem 0,0 e 80 passos/mm. O descarte usa a faixa
      externa ao tabuleiro no lado escolhido e assume que a peça foi retirada.
      Ajuste a folga ao diâmetro real das peças.
    </p>
  </details>
</div>`;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    el.setAttribute(key, value);
  }
  return el;
}

export function createXYTable(options = {}) {
  const opt = {
    confirm: async () => true,
    feedback: () => {},
    toast: () => {},
    onBusyChange: () => {},
    onActivateTab: () => {},
    getBoardOrientation: () => 'w',
    listenForConfirmation: null,
    cancelConfirmation: null,
    ...options,
  };

  const st = {
    mounted: false,
    mode: 'serial',
    connection: 'disconnected',
    connected: false,
    simulated: false,
    machine: null,
    connMessage: '',
    origem: false,
    boardSynced: false,
    board: null,
    lastFen: null,
    tray: [],
    magnet: false,
    magnetUnknown: false,
    pos: { x: 0, y: 0 },
    display: { x: 0, y: 0 },
    busy: false,
    busyLabel: '',
    abortRequested: false,
    enabled: true,
    settings: {
      orientation: 'bl',
      pieceRadius: 8,
      safety: 2,
      trayEnabled: true,
      traySide: 'left',
    },
    plan: null,
    planStatus: [],
    activeStep: -1,
    showOverlay: false,
    carryIndex: 0,
    carryTotal: 0,
    phase: '',
    phaseDetail: '',
    lifted: false,
    uncertain: false,
    boardChanged: false,
    captureRemoved: false,
    syncWarning: false,
    promotionPending: null,
    lastError: '',
    logLines: [],
    ui: {},
  };

  let lastFrame = 0;
  let rafId = 0;

  const ui = st.ui;

  /* ------------------------------------------------------------------------
     utilidades de UI
     ------------------------------------------------------------------------ */

  function id(name) {
    return document.getElementById(name);
  }

  function fmtOrDash(value) {
    return value === null || value === undefined ? '—' : String(value);
  }

  function log(message, type = 'muted') {
    const stamp = new Date().toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    st.logLines.push({ stamp, message, type });
    if (st.logLines.length > 100) st.logLines.shift();
    renderLog();
  }

  function renderLog() {
    if (!ui.log) return;
    ui.log.replaceChildren();
    for (const line of st.logLines) {
      const row = document.createElement('div');
      row.className = line.type;
      row.textContent = `${line.stamp}  ${line.message}`;
      ui.log.appendChild(row);
    }
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function feedback(message, type = 'info') {
    try {
      opt.feedback(message, type);
    } catch {
      /* ignore */
    }
  }

  function setBusy(busy, label = '') {
    st.busy = Boolean(busy);
    st.busyLabel = label;
    try {
      opt.onBusyChange(st.busy, label);
    } catch {
      /* ignore */
    }
    render();
  }

  function refreshPosition() {
    if (ui.x) ui.x.textContent = fmt2(st.pos.x);
    if (ui.y) ui.y.textContent = fmt2(st.pos.y);
    renderBadges();
    updateHead();
  }

  function renderBadges() {
    if (!ui.magnet) return;

    if (st.magnetUnknown) {
      ui.magnet.textContent = 'Ímã: verificar';
      ui.magnet.className = 'xy-badge danger';
    } else if (st.magnet) {
      ui.magnet.textContent = 'Ímã ligado';
      ui.magnet.className = 'xy-badge warn';
    } else {
      ui.magnet.textContent = 'Ímã desligado';
      ui.magnet.className = 'xy-badge';
    }

    ui.origin.textContent = st.origem
      ? 'Origem confirmada'
      : 'Origem não confirmada';
    ui.origin.className = `xy-badge ${st.origem ? 'on' : 'warn'}`;

    ui.syncState.textContent = st.boardSynced
      ? 'Mesa sincronizada'
      : 'Mesa não sincronizada';
    ui.syncState.className = `xy-badge ${st.boardSynced ? 'on' : 'warn'}`;
  }

  function connectionHint() {
    if (!st.enabled) {
      return 'Execução física desativada. O jogo está apenas na tela.';
    }
    if (st.connection === 'connecting') return 'Abrindo a conexão...';
    if (!st.connected) {
      return 'Jogo apenas na tela. Conecte o Arduino ou use a simulação.';
    }
    if (st.simulated) {
      return 'Simulação ativa: os lances são executados virtualmente.';
    }
    if (!st.origem) {
      return 'Arduino conectado. Posicione a mesa no zero físico e confirme a origem.';
    }
    if (!st.boardSynced) {
      return 'Ajuste as peças físicas para a posição do jogo e confirme a mesa sincronizada.';
    }
    return 'Mesa pronta. Os lances legais serão executados no tabuleiro físico.';
  }

  function render() {
    if (!st.mounted) return;

    const dotClass = !st.connected
      ? st.connection === 'connecting'
        ? 'on'
        : st.magnetUnknown
          ? 'err'
          : ''
      : st.simulated
        ? 'sim'
        : 'on';

    if (ui.dot) ui.dot.className = `xy-dot ${dotClass}`.trim();

    if (ui.connText) {
      ui.connText.textContent = st.connected
        ? st.simulated
          ? 'Simulação ativa'
          : 'Arduino conectado'
        : st.connection === 'connecting'
          ? 'Conectando...'
          : 'Jogo apenas na tela';
    }

    if (ui.connHint) {
      ui.connHint.textContent = connectionHint();
      ui.connHint.className = `hint ${
        st.connected && st.origem && st.boardSynced && st.enabled
          ? 'online'
          : st.magnetUnknown
            ? 'error'
            : ''
      }`.trim();
    }

    for (const button of ui.modeButtons) {
      button.classList.toggle('active', button.dataset.xyMode === st.mode);
      button.disabled = st.connected || st.connection === 'connecting' || st.busy;
    }

    if (ui.connect) {
      ui.connect.hidden = st.connected;
      ui.connect.disabled = st.busy || st.connection === 'connecting';
      ui.connect.textContent =
        st.connection === 'connecting'
          ? 'Conectando...'
          : st.mode === 'sim'
            ? 'Iniciar simulação'
            : 'Conectar Arduino';
    }

    if (ui.disconnect) {
      ui.disconnect.hidden = !st.connected;
      ui.disconnect.disabled = st.busy;
    }

    if (ui.zero) {
      ui.zero.disabled =
        !st.connected ||
        st.busy ||
        st.magnet ||
        st.magnetUnknown;
      ui.zero.textContent = st.origem
        ? 'Redefinir origem'
        : 'Confirmar origem';
    }

    if (ui.home) {
      ui.home.disabled = !st.connected || !st.origem || st.busy;
    }

    if (ui.magnetOff) {
      ui.magnetOff.disabled = !st.connected || st.busy;
    }

    if (ui.stop) {
      ui.stop.disabled = !st.connected;
    }

    if (ui.syncBtn) {
      ui.syncBtn.disabled = !st.connected || st.busy;
    }

    if (ui.enabled) {
      ui.enabled.checked = st.enabled;
      ui.enabled.disabled = st.busy;
    }

    if (ui.orientation) {
      ui.orientation.value = st.settings.orientation;
      ui.orientation.disabled = st.busy;
    }

    if (ui.trayEnabled) {
      ui.trayEnabled.checked = st.settings.trayEnabled;
      ui.trayEnabled.disabled = st.busy;
    }

    if (ui.traySide) {
      ui.traySide.value = st.settings.traySide;
      ui.traySide.disabled = st.busy;
    }

    if (ui.radius) {
      ui.radius.value = String(st.settings.pieceRadius);
      ui.radius.disabled = st.busy;
    }
    if (ui.radiusOut) {
      ui.radiusOut.textContent = `${fmt1(st.settings.pieceRadius)} mm`;
    }

    if (ui.safety) {
      ui.safety.value = String(st.settings.safety);
      ui.safety.disabled = st.busy;
    }
    if (ui.safetyOut) {
      ui.safetyOut.textContent = `${fmt1(st.settings.safety)} mm`;
    }

    if (ui.manualGo) {
      ui.manualGo.disabled =
        !st.connected ||
        !st.origem ||
        st.busy ||
        st.magnet;
    }
    if (ui.manualX) ui.manualX.disabled = st.busy;
    if (ui.manualY) ui.manualY.disabled = st.busy;

    refreshPosition();
    renderDanger();
    renderPromo();
    renderPlan();
    if (ui.phase) {
      ui.phase.textContent =
        st.phaseDetail ||
        (st.busy ? st.busyLabel : '') ||
        '';
      ui.phase.className = `hint ${st.lastError && !st.busy ? 'error' : ''}`.trim();
    }
  }

  function renderDanger() {
    if (!ui.danger) return;
    ui.danger.replaceChildren();

    const add = (text, cls = '') => {
      const div = document.createElement('div');
      div.className = `xy-danger-banner ${cls}`.trim();
      div.textContent = text;
      ui.danger.appendChild(div);
    };

    if (st.magnetUnknown) {
      add(
        'O estado do ímã não foi confirmado. Clique em “Ímã OFF” ou desligue a alimentação antes de continuar.'
      );
    } else if (st.uncertain) {
      add(
        'Uma peça ficou fora da casa. Ajuste a mesa física e confirme a sincronização antes de jogar novamente.'
      );
    } else if (st.syncWarning) {
      add(
        'A mesa física não acompanhou o último lance virtual. Ajuste as peças e confirme a sincronização.'
      );
    } else if (
      st.connected &&
      st.enabled &&
      !st.boardSynced &&
      !st.busy
    ) {
      add(
        'A mesa física ainda não foi confirmada para a posição atual do jogo. Use “Confirmar mesa sincronizada”.'
      );
    }
  }

  function confirmPromotionSwap() {
    const current = st.promotionPending;
    if (!current) return false;
    try {
      opt.cancelConfirmation?.();
    } catch {}
    st.promotionPending = null;
    render();
    current.resolve();
    return true;
  }

  function renderPromo() {
    if (!ui.promo) return;
    ui.promo.replaceChildren();

    const pending = st.promotionPending;
    if (!pending) return;

    const box = document.createElement('div');
    box.className = 'xy-promo';

    const text = document.createElement('div');
    text.textContent = pending.text;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn compact primary';
    button.textContent = 'Peça trocada';
    button.addEventListener('click', confirmPromotionSwap);

    box.append(text, button);
    ui.promo.appendChild(box);
  }

  function humanSquare(square) {
    if (isTraySquare(square)) return 'descarte';
    return String(square);
  }

  function roleText(move) {
    if (move.role === 'target' && move.label) return move.label.toUpperCase();
    return ROLE_TEXT[move.role] || 'JOGADA';
  }

  function renderPlan() {
    if (!ui.planList) return;

    if (!st.plan) {
      ui.planCount.textContent = '—';
      ui.planList.replaceChildren();
      const empty = document.createElement('li');
      empty.className = 'xy-empty';
      empty.textContent = 'Nenhum movimento físico em andamento.';
      ui.planList.appendChild(empty);
      return;
    }

    ui.planCount.textContent =
      st.plan.totalSteps === 1
        ? '1 etapa'
        : `${st.plan.totalSteps} etapas`;
    ui.planList.replaceChildren();

    st.plan.moves.forEach((move, index) => {
      const status = st.planStatus[index] || 'pending';
      const row = document.createElement('li');
      row.className = 'xy-plan-row';
      if (status === 'done') row.classList.add('done');
      if (status === 'active') row.classList.add('active');
      if (status === 'error') row.classList.add('error');

      const role = document.createElement('span');
      role.className = `xy-role ${move.role}`;
      role.textContent = roleText(move);

      const copy = document.createElement('span');
      copy.className = 'xy-plan-copy';

      const title = document.createElement('b');
      title.textContent = `${humanSquare(move.from)} → ${humanSquare(move.to)}`;

      const sub = document.createElement('small');
      sub.textContent = `${pieceLabel(move.piece)} · ${
        ROLE_COPY[move.role] || 'jogada principal'
      }`;

      if (isTraySquare(move.to)) {
        const point = squareToXY(move.to, st.settings.orientation);
        row.title = `${traySlotLabel(move.to)} · X ${fmt1(point.x)} mm · Y ${fmt1(
          point.y
        )} mm`;
      }

      copy.append(title, sub);

      const mm = document.createElement('span');
      mm.className = 'xy-plan-mm';
      mm.textContent = `${fmt1(move.path.length)} mm`;

      row.append(role, copy, mm);
      ui.planList.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------------
     traçado no tabuleiro virtual
     ------------------------------------------------------------------------ */

  function machineToBoard(point) {
    const colF = (point.x - CFG.board.x0) / SQ;
    const rowF = (point.y - CFG.board.y0) / SQ;
    let fileF = colF;
    let rankF = rowF;

    if (st.settings.orientation === 'br' || st.settings.orientation === 'tr') {
      fileF = 7 - colF;
    }
    if (st.settings.orientation === 'tl' || st.settings.orientation === 'tr') {
      rankF = 7 - rowF;
    }

    if (opt.getBoardOrientation() === 'w') {
      return { x: fileF, y: 8 - rankF };
    }
    return { x: 8 - fileF, y: rankF };
  }

  function pathData(points) {
    return points
      .map((point, index) => {
        const p = machineToBoard(point);
        return `${index === 0 ? 'M' : 'L'}${p.x.toFixed(4)} ${p.y.toFixed(4)}`;
      })
      .join(' ');
  }

  function drawOverlay() {
    if (!ui.overlay) return;
    ui.overlay.replaceChildren();

    if (!st.showOverlay || !st.plan || st.activeStep < 0) return;

    const move = st.plan.moves[st.activeStep];
    if (!move || !move.path.points?.length) return;

    const role = move.role || 'target';

    if (
      st.plan.kind !== 'direct' &&
      role !== 'target' &&
      st.plan.targetMove
    ) {
      ui.overlay.appendChild(
        svgEl('path', {
          d: pathData(st.plan.targetMove.path.points),
          class: 'xy-path-ghost',
        })
      );
    }

    const full = pathData(move.path.points);

    ui.overlay.appendChild(
      svgEl('path', { d: full, class: 'xy-path-under' })
    );
    ui.overlay.appendChild(
      svgEl('path', {
        d: full,
        class: `xy-path ${role === 'target' ? '' : role}`.trim(),
      })
    );

    if (st.carryIndex > 0) {
      const donePoints = move.path.points.slice(0, st.carryIndex + 1);

      if (
        st.lifted &&
        donePoints.length &&
        Math.hypot(
          st.display.x - donePoints[donePoints.length - 1].x,
          st.display.y - donePoints[donePoints.length - 1].y
        ) > 0.15
      ) {
        donePoints.push({ ...st.display });
      }

      if (donePoints.length > 1) {
        ui.overlay.appendChild(
          svgEl('path', {
            d: pathData(donePoints),
            class: 'xy-path-done',
          })
        );
      }
    }

    const start = machineToBoard(move.start);
    const end = machineToBoard(move.drop);

    ui.overlay.appendChild(
      svgEl('circle', {
        cx: start.x,
        cy: start.y,
        r: 0.17,
        class: `xy-ring ${role === 'target' ? '' : role}`.trim(),
      })
    );
    ui.overlay.appendChild(
      svgEl('circle', {
        cx: end.x,
        cy: end.y,
        r: 0.17,
        class: `xy-ring ${role === 'target' ? '' : role}`.trim(),
      })
    );

    if (isTraySquare(move.to)) {
      const left = st.settings.traySide !== 'right';
      const y = clamp(end.y, 0.35, 7.65);
      const arrow = left
        ? `M0.38 ${y - 0.18} L0.08 ${y} L0.38 ${y + 0.18}`
        : `M7.62 ${y - 0.18} L7.92 ${y} L7.62 ${y + 0.18}`;

      ui.overlay.appendChild(
        svgEl('path', { d: arrow, class: 'xy-edge-arrow' })
      );

    }

    const head = svgEl('g', { id: 'xyHead', style: 'display:none' });
    head.appendChild(
      svgEl('circle', {
        r: 0.48,
        class: 'xy-head-halo',
        style: st.magnet ? '' : 'display:none',
      })
    );
    head.appendChild(
      svgEl('circle', { r: 0.24, class: 'xy-head' })
    );
    head.appendChild(
      svgEl('circle', { r: 0.075, class: 'xy-head-dot' })
    );
    ui.overlay.appendChild(head);

    updateHead();
  }

  function updateHead() {
    const head = ui.overlay?.querySelector('#xyHead');
    if (!head) return;

    if (!st.showOverlay || !st.plan) {
      head.style.display = 'none';
      return;
    }

    const p = machineToBoard(st.display);
    if (p.x < -0.15 || p.x > 8.15 || p.y < -0.15 || p.y > 8.15) {
      head.style.display = 'none';
      return;
    }

    head.style.display = '';
    head.setAttribute('transform', `translate(${p.x.toFixed(4)},${p.y.toFixed(4)})`);

    const halo = head.querySelector('.xy-head-halo');
    if (halo) halo.style.display = st.magnet ? '' : 'none';
  }

  function frame(timestamp) {
    if (!lastFrame) lastFrame = timestamp;
    const dt = Math.min(60, timestamp - lastFrame);
    lastFrame = timestamp;
    const k = 1 - Math.exp(-dt / 55);

    st.display.x += (st.pos.x - st.display.x) * k;
    st.display.y += (st.pos.y - st.display.y) * k;

    if (Math.abs(st.pos.x - st.display.x) < 0.002) st.display.x = st.pos.x;
    if (Math.abs(st.pos.y - st.display.y) < 0.002) st.display.y = st.pos.y;

    updateHead();
    rafId = requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------------
     configurações
     ------------------------------------------------------------------------ */

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (['bl', 'br', 'tl', 'tr'].includes(saved.orientation)) {
        st.settings.orientation = saved.orientation;
      }
      if (Number.isFinite(Number(saved.pieceRadius))) {
        st.settings.pieceRadius = clamp(Number(saved.pieceRadius), 3, 15);
      }
      if (Number.isFinite(Number(saved.safety))) {
        st.settings.safety = clamp(Number(saved.safety), 0, 8);
      }
      if (typeof saved.trayEnabled === 'boolean') {
        st.settings.trayEnabled = saved.trayEnabled;
      }
      if (['left', 'right'].includes(saved.traySide)) {
        st.settings.traySide = saved.traySide;
      }
      if (typeof saved.enabled === 'boolean') st.enabled = saved.enabled;
    } catch {
      /* localStorage opcional */
    }
    syncTrayConfig(st.settings);
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          orientation: st.settings.orientation,
          pieceRadius: st.settings.pieceRadius,
          safety: st.settings.safety,
          trayEnabled: st.settings.trayEnabled,
          traySide: st.settings.traySide,
          enabled: st.enabled,
        })
      );
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------------
     máquina
     ------------------------------------------------------------------------ */

  const sink = {
    onPos(x, y) {
      st.pos = { x, y };
      refreshPosition();
    },

    onMagnet(on) {
      st.magnet = Boolean(on);
      st.magnetUnknown = false;
      renderBadges();
      renderDanger();
      updateHead();
    },

    onLine(direction, text) {
      if (direction === 'err' || /^ERRO/i.test(text) || text === 'STOPPED') {
        log(`${direction === 'err' ? 'Erro' : 'Arduino'}: ${text}`, 'err');
      }
    },

    onStatus(text) {
      st.connMessage = text;
    },

    onError(error) {
      st.lastError = error.message;
      log(`Arduino: ${error.message}`, 'err');
    },

    onDisconnect(error) {
      handleUnexpectedDisconnect(error);
    },
  };

  function resetMachineState() {
    st.machine = null;
    st.connected = false;
    st.connection = 'disconnected';
    st.simulated = false;
    st.origem = false;
    st.boardSynced = false;
    st.magnet = false;
    st.connMessage = '';
  }

  function handleUnexpectedDisconnect(error) {
    if (!st.connected && st.connection !== 'connecting') return;

    const risk = st.magnet || st.lifted;

    st.connected = false;
    st.connection = 'disconnected';
    st.machine = null;
    st.simulated = false;
    st.origem = false;
    st.boardSynced = false;
    st.magnetUnknown = risk;
    st.connMessage = error?.message || 'Conexão encerrada.';
    st.lastError = error?.message || 'Conexão encerrada.';

    log(
      `Conexão perdida: ${st.connMessage}`,
      'err'
    );

    if (risk) {
      feedback(
        'A conexão caiu com o ímã ligado. Desligue a alimentação do eletroímã.',
        'error'
      );
    } else {
      feedback('Conexão com o Arduino perdida.', 'error');
    }

    render();
  }

  async function connect() {
    if (st.connected || st.connection === 'connecting') return;

    st.connection = 'connecting';
    st.connMessage = 'Abrindo conexão...';
    render();

    const machine =
      st.mode === 'sim' ? new SimMachine(sink) : new SerialMachine(sink);
    st.machine = machine;

    try {
      await machine.connect();

      st.connected = true;
      st.connection = 'connected';
      st.simulated = st.mode === 'sim';
      st.magnet = false;
      st.magnetUnknown = false;
      st.pos = { x: 0, y: 0 };
      st.display = { x: 0, y: 0 };

      if (st.simulated) {
        st.origem = true;
        st.boardSynced = true;
        log('Simulação iniciada. O jogo será executado virtualmente.', 'ok');
        feedback('Simulação ativa. Os lances serão executados virtualmente.', 'success');
      } else {
        st.origem = false;
        st.boardSynced = false;
        const imaUnknown = !machine.magnetConfirmed;
        st.magnetUnknown = imaUnknown;
        log('Arduino conectado. Confirme a origem e a mesa sincronizada.', 'ok');
        feedback(
          imaUnknown
            ? 'Arduino conectado, mas o estado do ímã não foi confirmado. Clique em Ímã OFF.'
            : 'Arduino conectado. Confirme a origem física (ZERO).',
          imaUnknown ? 'error' : 'warning'
        );
      }

      render();
    } catch (error) {
      try {
        await machine.disconnect();
      } catch {}

      st.machine = null;
      st.connected = false;
      st.connection = 'disconnected';
      st.simulated = false;
      st.connMessage = 'Falha na conexão.';
      log(`Falha na conexão: ${error.message}`, 'err');
      feedback(`Falha na conexão: ${error.message}`, 'error');
      render();
    }
  }

  async function disconnect() {
    if (!st.machine) return;
    if (st.busy) {
      feedback('Pare o movimento físico antes de desconectar.', 'warning');
      return;
    }

    const machine = st.machine;
    const magnetRisk = st.magnet || st.magnetUnknown;

    try {
      await machine.disconnect();
    } catch (error) {
      log(`Erro ao desconectar: ${error.message}`, 'err');
    }

    st.machine = null;
    st.connected = false;
    st.connection = 'disconnected';
    st.simulated = false;
    st.origem = false;
    st.boardSynced = false;
    st.magnet = false;
    st.magnetUnknown = magnetRisk;
    st.connMessage = '';

    log('Mesa desconectada.', 'muted');
    render();
  }

  async function confirmZero() {
    if (!st.connected || !st.machine || st.busy) return;

    if (st.magnet) {
      feedback('Desligue o ímã antes de redefinir a origem.', 'warning');
      return;
    }

    const accepted = await opt.confirm({
      title: 'Confirmar origem física',
      text:
        'Posicione a mesa fisicamente em X=0, Y=0 antes de continuar.\n\n' +
        'O comando ZERO define a posição atual como 0,0. Se a mesa não estiver na origem, todas as coordenadas ficarão deslocadas.',
      okLabel: 'Enviar ZERO',
    });
    if (!accepted) return;

    try {
      await st.machine.zero();
      st.origem = true;
      st.pos = { x: 0, y: 0 };
      st.display = { x: 0, y: 0 };
      log('Origem física definida em 0,0.', 'ok');
      feedback('Origem confirmada.', 'success');
    } catch (error) {
      st.origem = false;
      log(`Falha ao definir origem: ${error.message}`, 'err');
      feedback(`Falha ao definir origem: ${error.message}`, 'error');
    }

    render();
  }

  async function goHome() {
    if (!st.connected || !st.machine || !st.origem || st.busy) return;
    if (st.magnet) {
      feedback('Desligue o ímã antes de mover.', 'warning');
      return;
    }

    setBusy(true, 'Retornando a 0,0…');
    try {
      await st.machine.goto(0, 0);
      st.pos = { x: 0, y: 0 };
      log('Retorno a 0,0 concluído.', 'ok');
      feedback('Mesa em 0,0.', 'success');
    } catch (error) {
      log(`Falha ao retornar a 0,0: ${error.message}`, 'err');
      feedback(`Falha ao retornar a 0,0: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    if (!st.connected || !st.machine) return;

    st.abortRequested = true;
    log('PARADA solicitada.', 'warn');

    try {
      await st.machine.stop();
    } catch {}

    try {
      if (typeof st.machine.forceMagnetOff === 'function') {
        await st.machine.forceMagnetOff();
      } else {
        await st.machine.ima(false);
      }

      for (let i = 0; i < 12 && st.magnet; i += 1) await delay(150);

      if (st.magnet) throw new Error('O Arduino não confirmou IMA,0.');
      log('Ímã desligado pela parada.', 'warn');
    } catch (error) {
      st.magnetUnknown = true;
      log(`Não foi possível confirmar o ímã desligado: ${error.message}`, 'err');
      feedback('Desligue a alimentação do eletroímã.', 'error');
    }

    render();
  }

  async function magnetOff() {
    if (!st.connected || !st.machine) return;
    if (st.busy) {
      await stopAll();
      return;
    }

    try {
      await st.machine.ima(false);
      log('Ímã desligado manualmente.', 'warn');
      feedback('Ímã desligado.', 'success');
    } catch (error) {
      st.magnetUnknown = true;
      log(`Falha ao desligar o ímã: ${error.message}`, 'err');
      feedback('Não foi possível confirmar o ímã desligado.', 'error');
    }

    render();
  }

  async function manualMove() {
    if (!st.connected || !st.machine || !st.origem || st.busy) return;
    if (st.magnet) {
      feedback('Desligue o ímã antes de mover manualmente.', 'warning');
      return;
    }

    const x = Number(ui.manualX?.value);
    const y = Number(ui.manualY?.value);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 400 ||
      y < 0 ||
      y > 400
    ) {
      feedback('As coordenadas devem estar entre 0 e 400 mm.', 'warning');
      return;
    }

    setBusy(true, 'Movimento manual…');
    try {
      await st.machine.goto(x, y);
      st.pos = { x, y };
      log(`Movimento manual para X ${fmt1(x)} / Y ${fmt1(y)} mm.`, 'muted');
    } catch (error) {
      log(`Movimento manual interrompido: ${error.message}`, 'err');
      feedback(`Movimento manual: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function confirmBoardSynced() {
    if (!st.connected) return;
    st.boardSynced = true;
    st.syncWarning = false;
    st.uncertain = false;
    log(
      'Mesa física confirmada. O descarte é considerado retirado.',
      'ok'
    );
    feedback('Mesa sincronizada. Os próximos lances serão físicos.', 'success');
    render();
  }

  function setTraySide(side) {
    if (st.busy) return;

    if (!['left', 'right'].includes(side)) side = 'left';

    if (side === st.settings.traySide) {
      render();
      return;
    }

    st.settings.traySide = side;
    syncTrayConfig(st.settings);
    saveSettings();
    log(
      side === 'right'
        ? 'Descarte movido para a direita da mesa (X 380 mm).'
        : 'Descarte movido para a esquerda da mesa (X 20 mm).',
      'muted'
    );
    render();
    redraw();
  }

  /* ------------------------------------------------------------------------
     montagem
     ------------------------------------------------------------------------ */

  function mount() {
    if (st.mounted) return;

    const panel = document.getElementById('tab-xy');
    if (!panel) {
      console.warn('Mesa XY: painel #tab-xy não encontrado.');
      return;
    }

    panel.innerHTML = PANEL_TEMPLATE;

    ui.connText = id('xyConnText');
    ui.dot = id('xyDot');
    ui.modeButtons = [...panel.querySelectorAll('[data-xy-mode]')];
    ui.connect = id('xyConnect');
    ui.disconnect = id('xyDisconnect');
    ui.connHint = id('xyConnHint');
    ui.x = id('xyX');
    ui.y = id('xyY');
    ui.magnet = id('xyMagnet');
    ui.origin = id('xyOrigin');
    ui.syncState = id('xySyncState');
    ui.zero = id('xyZero');
    ui.home = id('xyHome');
    ui.magnetOff = id('xyMagnetOff');
    ui.stop = id('xyStop');
    ui.enabled = id('xyEnabled');
    ui.syncBtn = id('xySyncBtn');
    ui.danger = id('xyDanger');
    ui.promo = id('xyPromo');
    ui.planCount = id('xyPlanCount');
    ui.phase = id('xyPhase');
    ui.planList = id('xyPlanList');
    ui.log = id('xyLog');
    ui.trayEnabled = id('xyTrayEnabled');
    ui.traySide = id('xyTraySide');
    ui.orientation = id('xyOrientation');
    ui.radius = id('xyRadius');
    ui.radiusOut = id('xyRadiusOut');
    ui.safety = id('xySafety');
    ui.safetyOut = id('xySafetyOut');
    ui.manualX = id('xyManualX');
    ui.manualY = id('xyManualY');
    ui.manualGo = id('xyManualGo');

    ui.overlay = document.getElementById('xyBoardOverlay');
    if (!ui.overlay) {
      ui.overlay = svgEl('svg', {
        id: 'xyBoardOverlay',
        class: 'xy-overlay',
        viewBox: '0 0 8 8',
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
      });
      document.querySelector('.board')?.appendChild(ui.overlay);
    }

    loadSettings();

    ui.modeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        if (st.connected || st.connection === 'connecting' || st.busy) return;
        st.mode = button.dataset.xyMode;
        render();
      });
    });

    ui.connect?.addEventListener('click', connect);
    ui.disconnect?.addEventListener('click', disconnect);
    ui.zero?.addEventListener('click', confirmZero);
    ui.home?.addEventListener('click', goHome);
    ui.stop?.addEventListener('click', stopAll);
    ui.magnetOff?.addEventListener('click', magnetOff);
    ui.syncBtn?.addEventListener('click', confirmBoardSynced);
    ui.manualGo?.addEventListener('click', manualMove);

    ui.enabled?.addEventListener('change', () => {
      st.enabled = ui.enabled.checked;
      saveSettings();
      log(
        st.enabled
          ? 'Execução física ativada.'
          : 'Execução física desativada; o jogo ficará só na tela.',
        'muted'
      );
      render();
    });

    ui.trayEnabled?.addEventListener('change', () => {
      if (st.busy) return;
      st.settings.trayEnabled = ui.trayEnabled.checked;
      syncTrayConfig(st.settings);
      saveSettings();
      log(
        st.settings.trayEnabled
          ? 'Recolhimento automático de capturas ativado.'
          : 'Recolhimento automático de capturas desativado.',
        'muted'
      );
      render();
    });

    ui.traySide?.addEventListener('change', () => {
      setTraySide(ui.traySide.value === 'right' ? 'right' : 'left');
    });

    ui.orientation?.addEventListener('change', () => {
      if (st.busy) return;
      st.settings.orientation = ui.orientation.value;
      saveSettings();
      log('Canto físico do a1 atualizado.', 'muted');
      render();
      redraw();
    });

    for (const [input, key, out, formatter] of [
      [ui.radius, 'pieceRadius', ui.radiusOut, fmt1],
      [ui.safety, 'safety', ui.safetyOut, fmt1],
    ]) {
      input?.addEventListener('input', () => {
        if (st.busy) return;
        st.settings[key] = clamp(Number(input.value), 0, 15);
        if (key === 'pieceRadius') {
          st.settings[key] = clamp(Number(input.value), 3, 15);
        }
        if (out) out.textContent = `${formatter(st.settings[key])} mm`;
        saveSettings();
      });
    }

    st.mounted = true;
    st.lastFen = null;

    log('Mesa XY pronta. Conecte o Arduino ou use a simulação.', 'ok');
    log('O jogo mantém regras completas; a mesa executa apenas lances legais.', 'muted');

    render();
    rafId = requestAnimationFrame(frame);
  }

  function redraw() {
    drawOverlay();
    updateHead();
  }

  function noteGameChanged(fen, { reason = 'change' } = {}) {
    st.lastFen = fen;
    st.board = null;
    st.tray = [];
    st.boardSynced = false;
    st.plan = null;
    st.planStatus = [];
    st.activeStep = -1;
    st.showOverlay = false;
    st.carryIndex = 0;
    st.uncertain = false;
    st.boardChanged = false;
    st.captureRemoved = false;
    st.syncWarning = false;

    if (
      reason !== 'init' &&
      st.connected &&
      st.enabled &&
      !st.simulated
    ) {
      feedback(
        'O jogo mudou. Ajuste as peças e confirme a mesa sincronizada.',
        'warning'
      );
    }

    log(
      reason === 'init'
        ? 'Mesa XY aguardando sincronização inicial.'
        : 'Jogo alterado. A mesa física precisa ser sincronizada novamente.',
      'muted'
    );

    drawOverlay();
    render();
  }

  function noteGameCommitted(fen, { physical = false } = {}) {
    st.lastFen = fen;

    if (physical) {
      st.boardSynced = true;
      st.syncWarning = false;
      st.uncertain = false;
      log('Mesa física sincronizada com o lance aplicado.', 'ok');
    } else {
      st.boardSynced = false;
      st.syncWarning = st.connected && st.enabled;
      st.plan = null;
      st.planStatus = [];
      st.activeStep = -1;
      st.showOverlay = false;

      if (st.connected && st.enabled) {
        feedback(
          'Lance aplicado apenas na tela. Ajuste a mesa física e confirme a sincronização.',
          'warning'
        );
      }
    }

    drawOverlay();
    render();
  }

  /* ------------------------------------------------------------------------
     Execução de um lance de xadrez no tabuleiro físico
     ------------------------------------------------------------------------ */

  function phaseText(text) {
    st.phaseDetail = text;
    render();
  }

  async function executeStep(move, stepIndex, stepCount) {
    const machine = st.machine;
    const prefix = stepCount > 1 ? `${stepIndex + 1}/${stepCount} · ` : '';
    let released = false;

    st.lifted = false;
    st.carryIndex = 0;
    st.carryTotal = Math.max(1, move.path.segments);

    try {
      if (st.magnet) {
        await machine.ima(false);
      }

      phaseText(
        `${prefix}Indo até ${humanSquare(move.from)} (ímã desligado).`
      );
      log(
        `${prefix}Indo até ${humanSquare(move.from)} com o ímã desligado.`,
        'info'
      );
      await machine.goto(move.start.x, move.start.y);

      if (st.abortRequested) throw new MachineStopError('Parada solicitada.');
      st.pos = { ...move.start };
      refreshPosition();

      phaseText(`${prefix}Ligando o ímã em ${humanSquare(move.from)}.`);
      log(`${prefix}Ímã ON em ${humanSquare(move.from)}.`, 'info');
      await machine.ima(true);
      await delay(CFG.pickDwellMs);

      if (st.abortRequested) throw new MachineStopError('Parada solicitada.');
      if (!st.magnet) throw new Error('O Arduino não confirmou o ímã ligado.');

      st.lifted = true;
      drawOverlay();

      phaseText(
        `${prefix}Levando ${humanSquare(move.from)} → ${humanSquare(move.to)}.`
      );
      log(
        `${prefix}Levando ${humanSquare(move.from)} → ${humanSquare(
          move.to
        )} por ${move.path.segments} trecho(s).`,
        'info'
      );

      for (let i = 1; i < move.path.points.length; i += 1) {
        if (st.abortRequested) throw new MachineStopError('Parada solicitada.');

        const point = move.path.points[i];
        st.phase = 'carry';
        st.phaseDetail = `${prefix}Trecho ${i}/${move.path.segments} · X ${fmt1(point.x)} / Y ${fmt1(point.y)} mm`;
        render();

        await machine.goto(point.x, point.y);

        if (!st.magnet) {
          throw new MachineStopError(
            'O ímã foi desligado durante o transporte; a peça pode ter sido solta.'
          );
        }

        st.carryIndex = i;
        drawOverlay();
      }

      if (st.abortRequested) throw new MachineStopError('Parada solicitada.');
      st.pos = { ...move.drop };
      refreshPosition();

      phaseText(`${prefix}Soltando a peça em ${humanSquare(move.to)}.`);
      log(`${prefix}Ímã OFF em ${humanSquare(move.to)}.`, 'info');
      await delay(CFG.releaseDwellMs);
      await machine.ima(false);

      if (st.magnet) {
        throw new Error('O Arduino não confirmou o desligamento do ímã.');
      }

      released = true;
      st.lifted = false;
      if (move.role === 'discard') {
        // A peça capturada é deixada no descarte e considerada retirada pelo
        // usuário; não fica ocupando vagas nem bloqueando os próximos planos.
        st.board = cloneBoard(st.board);
        delete st.board[move.from];
      } else {
        st.board = boardWithMove(st.board, move.from, move.to);
      }
      st.tray = [];
      st.boardChanged = true;
      st.carryIndex = move.path.points.length - 1;
      drawOverlay();

      if (st.abortRequested) {
        throw new MachineStopError(
          'Parada solicitada após soltar a peça; o retorno à origem não foi executado.'
        );
      }

      phaseText(`${prefix}Voltando a 0,0 (ímã desligado).`);
      log(`${prefix}Voltando a 0,0.`, 'info');
      await machine.goto(0, 0);
      st.pos = { x: 0, y: 0 };
      refreshPosition();
      phaseText(`${prefix}Motores em 0,0.`);
      log(`${prefix}Etapa concluída com a mesa em 0,0.`, 'muted');
    } catch (error) {
      error.planStep = stepIndex;
      error.released = released;
      if (st.lifted) st.uncertain = true;
      throw error;
    }
  }

  async function runPlan(plan) {
    const blockersText = (plan.blockers || [])
      .map(
        (blocker) =>
          `${blocker.square} (${PIECE_NAMES[blocker.piece.type] || blocker.piece.type})`
      )
      .join(', ');

    const stepsLabel =
      plan.totalSteps === 1 ? '1 etapa' : `${plan.totalSteps} etapas`;

    log(
      plan.kind === 'castle'
        ? `Plano de roque físico: ${stepsLabel}.`
        : plan.kind === 'capture'
          ? `Plano de captura: ${stepsLabel}, ${fmt1(plan.totalLength)} mm. A peça capturada vai para o descarte e é considerada retirada.`
          : `Plano físico: ${stepsLabel}, ${fmt1(plan.totalLength)} mm de traçado.`,
      'info'
    );

    if (plan.kind === 'capture' && plan.captured) {
      const point = squareToXY(plan.captured.tray, st.settings.orientation);
      log(
        `Peça capturada: ${plan.captured.square} → ${traySlotLabel(
          plan.captured.tray
        )} (X ${fmt1(point.x)} / Y ${fmt1(point.y)} mm).`,
        'warn'
      );
    }

    if (blockersText) {
      log(`Peças temporárias que abrem caminho: ${blockersText}.`, 'muted');
    }

    for (let i = 0; i < plan.moves.length; i += 1) {
      if (st.abortRequested) throw new MachineStopError('Parada solicitada.');

      const move = plan.moves[i];

      st.activeStep = i;
      st.planStatus[i] = 'active';
      st.carryIndex = 0;
      st.carryTotal = move.path.segments;
      st.phaseDetail = `${i + 1}/${plan.moves.length} · ${roleText(
        move
      )} ${humanSquare(move.from)} → ${humanSquare(move.to)}`;

      render();
      drawOverlay();

      log(
        `Etapa ${i + 1}/${plan.moves.length} · ${roleText(move)}: ${humanSquare(
          move.from
        )} → ${humanSquare(move.to)} (${pieceLabel(move.piece)}).`,
        'info'
      );

      await executeStep(move, i, plan.moves.length);

      st.planStatus[i] = 'done';
      st.phaseDetail = `Etapa ${i + 1}/${plan.moves.length} concluída.`;
      render();
    }

    st.phaseDetail = 'Plano físico concluído.';
    render();
  }

  async function waitPromotionSwap(info) {
    const label = PROMO_LABELS[info.promotion] || 'Dama';
    const text = `Troque fisicamente o peão por ${label} em ${info.to} e clique em “Peça trocada”.`;

    log(text, 'warn');
    feedback(text, 'warning');
    opt.onActivateTab?.();
    setBusy(true, `Troque o peão por ${label} em ${info.to}…`);

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        st.promotionPending = null;
        renderPromo();
        resolve();
      };

      st.promotionPending = { text, resolve: finish };
      renderPromo();

      if (typeof opt.listenForConfirmation === 'function') {
        Promise.resolve(opt.listenForConfirmation('promotion'))
          .then((confirmed) => {
            if (confirmed) finish();
          })
          .catch(() => {});
      }
    });

    log('Peça de promoção trocada.', 'ok');
  }

  async function executeChessMove(info, { source = 'game' } = {}) {
    if (!st.enabled) {
      return { ok: true, executed: false, visual: true };
    }

    if (!st.connected) {
      return { ok: true, executed: false, visual: true };
    }

    if (st.busy) {
      return {
        ok: false,
        canCommitVisually: false,
        message: 'A mesa física está executando outro movimento.',
      };
    }

    if (st.magnetUnknown) {
      return {
        ok: false,
        canCommitVisually: true,
        message: 'Confirme o estado do ímã com “Ímã OFF” antes de jogar.',
      };
    }

    if (!st.origem) {
      return {
        ok: false,
        canCommitVisually: true,
        message: 'Confirme a origem física da mesa (ZERO) antes de jogar.',
      };
    }

    if (!st.boardSynced) {
      return {
        ok: false,
        canCommitVisually: true,
        message:
          'A mesa física não está sincronizada com o jogo. Ajuste as peças e confirme a sincronização.',
      };
    }

    if (st.magnet) {
      try {
        await st.machine.ima(false);
      } catch (error) {
        return {
          ok: false,
          canCommitVisually: true,
          message: `Não foi possível desligar o ímã: ${error.message}`,
        };
      }
    }

    const board = parseFEN(info.fen);
    for (const item of st.tray) {
      board[item.slot] = { ...item.piece };
    }

    const movingPiece = board[info.from];

    if (!movingPiece) {
      return {
        ok: false,
        canCommitVisually: true,
        message: `Não há peça em ${info.from} no modelo físico. Sincronize a mesa.`,
      };
    }

    let captureRemoved = false;
    const autoTray = Boolean(info.capture && st.settings.trayEnabled);

    if (info.capture) {
      const capturedSquare = info.capturedSquare || info.to;
      const captured = board[capturedSquare];

      if (!captured) {
        return {
          ok: false,
          canCommitVisually: true,
          message:
            'A peça capturada não está no modelo físico. Ajuste a mesa e confirme a sincronização.',
        };
      }

      if (!autoTray) {
        const accepted = await opt.confirm({
          title: 'Captura',
          text:
            `A casa ${capturedSquare} está ocupada por ${pieceLabel(captured)}.\n\n` +
            'Remova fisicamente a peça capturada do tabuleiro e confirme. ' +
            'O recolhimento automático está desativado.',
          okLabel: 'Já removi',
        });

        if (!accepted) {
          return {
            ok: false,
            canCommitVisually: true,
            message: 'Captura não confirmada; o lance não foi executado.',
          };
        }

        delete board[capturedSquare];
        captureRemoved = true;
      }
    }

    setBusy(true, 'Calculando trajeto físico…');
    await delay(30);

    let plan = null;

    try {
      if (info.kcastle || info.qcastle) {
        plan = buildCastlePlan(board, info, st.settings);

        if (!plan) {
          setBusy(false);
          const manual = await opt.confirm({
            title: 'Roque físico',
            text:
              'Não encontrei um traçado automático para o roque nesta posição.\n\n' +
              'Mova manualmente o rei e a torre para as casas do roque e confirme. ' +
              'Depois o lance será aplicado no jogo.',
            okLabel: 'Já movi o rei e a torre',
          });

          if (!manual) {
            return {
              ok: false,
              canCommitVisually: true,
              message: 'Roque físico não executado.',
            };
          }

          st.boardSynced = true;
          st.syncWarning = false;
          st.plan = null;
          st.planStatus = [];
          st.activeStep = -1;
          st.showOverlay = false;
          drawOverlay();
          log('Roque executado manualmente e confirmado.', 'warn');
          feedback('Roque físico confirmado.', 'success');
          render();
          return { ok: true, executed: true, manual: true };
        }
      } else if (autoTray) {
        plan = buildCapturePlan(board, info, st.settings);

        if (!plan.ok) {
          setBusy(false);
          log(`Sem plano de captura: ${plan.reason}`, 'warn');
          render();
          return {
            ok: false,
            canCommitVisually: true,
            message:
              `${plan.reason} ` +
              'Você pode aplicar o lance apenas na tela e sincronizar a mesa depois.',
          };
        }
      } else {
        plan = buildMovePlan(board, info.from, info.to, st.settings);

        if (!plan.ok) {
          setBusy(false);
          if (captureRemoved) {
            st.boardSynced = false;
            st.syncWarning = true;
          }
          log(`Sem plano físico: ${plan.reason}`, 'warn');
          render();
          return {
            ok: false,
            canCommitVisually: true,
            message:
              `${plan.reason} ` +
              'O lance pode ser aplicado apenas na tela e a mesa sincronizada depois.',
          };
        }
      }
    } catch (error) {
      setBusy(false);
      if (captureRemoved) {
        st.boardSynced = false;
        st.syncWarning = true;
      }
      render();
      return {
        ok: false,
        canCommitVisually: true,
        message: `Erro ao planejar o movimento físico: ${error.message}`,
      };
    }

    st.board = board;
    st.tray = [];
    st.boardChanged = false;
    st.captureRemoved = captureRemoved;
    st.uncertain = false;
    st.plan = plan;
    st.planStatus = plan.moves.map(() => 'pending');
    st.activeStep = -1;
    st.showOverlay = true;
    st.carryIndex = 0;
    st.carryTotal = 0;
    st.phase = '';
    st.phaseDetail = '';
    st.abortRequested = false;
    st.lastError = '';
    st.syncWarning = false;

    opt.onActivateTab?.();
    setBusy(true, 'Executando no tabuleiro físico…');
    render();
    drawOverlay();

    log(
      `Executando lance ${info.from} → ${info.to} (${source}).`,
      'info'
    );

    try {
      await runPlan(plan);

      if (info.promotion) {
        await waitPromotionSwap(info);
      }

      st.boardSynced = true;
      st.uncertain = false;
      st.syncWarning = false;
      st.showOverlay = false;
      st.activeStep = -1;
      st.phaseDetail =
        plan.kind === 'capture'
          ? 'Captura concluída. Peça no descarte, mesa em 0,0.'
          : 'Movimento físico concluído. Mesa em 0,0.';
      drawOverlay();
      log(
        plan.kind === 'capture'
          ? 'Movimento físico concluído; peça capturada descartada.'
          : 'Movimento físico concluído.',
        'ok'
      );
      setBusy(false);
      return { ok: true, executed: true };
    } catch (error) {
      const released = Boolean(error.released);
      const stepIndex = Number.isInteger(error.planStep)
        ? error.planStep
        : st.activeStep;
      const lastStep = stepIndex === plan.moves.length - 1;

      st.lastError = error.message;

      // Se a última peça já foi solta e o plano físico terminou, o lance
      // está fisicamente completo; apenas o retorno a 0,0 falhou.
      if (released && lastStep) {
        st.planStatus[stepIndex] = 'done';
        st.uncertain = false;
        st.boardChanged = true;
        st.boardSynced = true;
        st.syncWarning = false;
        st.showOverlay = false;
        st.activeStep = -1;
        st.phaseDetail =
          'Lance físico concluído, mas houve falha no retorno a 0,0. Use “Ir para 0,0”.';
        drawOverlay();
        log(
          `Lance físico concluído; falha apenas no retorno a 0,0: ${error.message}`,
          'warn'
        );
        feedback(
          'Lance físico concluído. A mesa não voltou a 0,0; use “Ir para 0,0”.',
          'warning'
        );

        if (info.promotion) {
          await waitPromotionSwap(info);
        }

        setBusy(false);
        return {
          ok: true,
          executed: true,
          warning: 'A mesa não retornou a 0,0.',
        };
      }

      st.showOverlay = false;
      st.activeStep = -1;
      drawOverlay();

      if (Number.isInteger(stepIndex) && plan.moves[stepIndex]) {
        st.planStatus[stepIndex] = 'error';
      }

      if (st.uncertain || st.boardChanged || captureRemoved) {
        st.boardSynced = false;
        st.syncWarning = true;
      }

      st.phaseDetail =
        st.uncertain
          ? 'Peça fora da casa. Sincronize a mesa antes de continuar.'
          : st.boardChanged
            ? 'Plano interrompido com peças fora das casas originais. Sincronize a mesa.'
            : 'Movimento físico não executado.';

      log(
        `Movimento físico interrompido${Number.isInteger(stepIndex) ? ` na etapa ${stepIndex + 1}/${plan.moves.length}` : ''}: ${error.message}`,
        'err'
      );
      feedback(
        st.uncertain
          ? 'Peça fora da casa. Ajuste a mesa e confirme a sincronização.'
          : `Movimento físico não concluído: ${error.message}`,
        'error'
      );

      setBusy(false);

      return {
        ok: false,
        canCommitVisually: !st.uncertain && !st.boardChanged,
        message: error.message,
        uncertain: st.uncertain,
      };
    }
  }

  return {
    mount,
    executeChessMove: (...args) => executeChessMove(...args),
    noteGameChanged,
    noteGameCommitted,
    redraw,
    confirmPromotionSwap,
    hasPendingPromotion: () => Boolean(st.promotionPending),
    confirmBoardSynced,
    confirmZero,
    stopAll,
    magnetOff,
    isBusy: () => st.busy,
    isEnabled: () => st.enabled,
    isConnected: () => st.connected,
    __debug: {
      parseFEN,
      buildMovePlan,
      buildCastlePlan,
      buildCapturePlan,
      planPathForBoard,
      traySlotXY,
      TRAY_SLOTS,
      get trayConfig() {
        return { ...CFG.tray };
      },
    },
    getStatus: () => ({
      connected: st.connected,
      simulated: st.simulated,
      origem: st.origem,
      boardSynced: st.boardSynced,
      magnet: st.magnet,
      pos: { ...st.pos },
      planKind: st.plan?.kind || null,
      busy: st.busy,
      tray: st.tray.map((item) => ({
        slot: item.slot,
        piece: { ...item.piece },
      })),
      trayEnabled: st.settings.trayEnabled,
      traySide: st.settings.traySide,
    }),
  };
}

