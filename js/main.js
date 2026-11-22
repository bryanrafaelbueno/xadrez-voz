/**
 * Xadrez Voz — application controller.
 * Wires the rules engine, voice input, local Whisper, chess AI and UI.
 */

import {
  Chess, START_FEN, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  FLAG_CAPTURE, FLAG_EP, FLAG_KCASTLE, FLAG_QCASTLE,
  moveFrom, moveTo, movePromotion, moveFlags, moveToUci, sqToName, nameToSq, PIECE_LETTERS,
} from './chess.js';
import { configForElo, levelForElo, eloForLevel, ELO_MIN, ELO_MAX, DEFAULT_ELO } from './ai.js';
import { parseCommand, parsePromotionPiece } from './parser.js';
import { VoiceInput } from './voice.js';
import { Narrator } from './speech.js';
import { Sounds } from './sound.js';
import {
  STRINGS, t, PIECE_NAMES, describeMove, describeResult,
} from './i18n.js';

const SETTINGS_KEY = 'xvoz.settings.v1';
const STATIC_MODE = (() => {
  try {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(window.location.search).has('static')) return true;
    if (window.location.protocol === 'file:') return true;
    return /(^|\.)github\.io$/i.test(window.location.hostname);
  } catch {
    return false;
  }
})();
const PIECE_VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const PROMO_ORDER = ['Q', 'R', 'B', 'N'];
const LETTER_TO_TYPE = { P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN };
const TYPE_TO_LETTER = { [PAWN]: 'P', [KNIGHT]: 'N', [BISHOP]: 'B', [ROOK]: 'R', [QUEEN]: 'Q', [KING]: 'K' };
const PIECE_IMG = (color, letter) => `assets/pieces/${color === 'w' ? 'w' : 'b'}${String(letter).toUpperCase()}.svg`;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const colorInt = (color) => (color === 'w' ? WHITE : BLACK);
const colorLetter = (side) => (side === WHITE ? 'w' : 'b');

const dom = {
  board: $('board'),
  squares: $('squares'),
  pieces: $('pieces'),
  boardBusy: $('boardBusy'),
  evalRail: $('evalRail'),
  evalWhite: $('evalWhite'),

  topCard: $('topCard'),
  bottomCard: $('bottomCard'),
  topAvatar: $('topAvatarImg'),
  bottomAvatar: $('bottomAvatarImg'),
  topName: $('topName'),
  bottomName: $('bottomName'),
  topSub: $('topSub'),
  bottomSub: $('bottomSub'),
  topCaptured: $('topCaptured'),
  bottomCaptured: $('bottomCaptured'),
  topAdv: $('topAdv'),
  bottomAdv: $('bottomAdv'),
  topSpinner: $('topSpinner'),
  bottomSpinner: $('bottomSpinner'),

  turnDot: $('turnDot'),
  statusText: $('statusText'),
  statusSub: $('statusSub'),

  moveList: $('moveList'),
  moveCount: $('moveCount'),

  engineStatus: $('engineStatus'),
  engineDot: $('engineDot'),
  engineStatusText: $('engineStatusText'),

  voiceBadge: $('voiceBadge'),
  micBtn: $('micBtn'),
  micFloat: $('micFloat'),
  meter: $('meter'),
  voiceState: $('voiceState'),
  voiceSub: $('voiceSub'),
  transcriptText: $('transcriptText'),
  transcriptSource: $('transcriptSource'),
  feedback: $('feedback'),
  textForm: $('textForm'),
  textInput: $('textInput'),
  exampleChips: $('exampleChips'),

  newBtn: $('newBtn'),
  undoBtn: $('undoBtn'),
  flipBtn: $('flipBtn'),
  hintBtn: $('hintBtn'),
  resignBtn: $('resignBtn'),
  soundBtn: $('soundBtn'),
  helpBtn: $('helpBtn'),

  langSwitch: $('langSwitch'),
  langControl: $('langControl'),
  modeControl: $('modeControl'),
  sideControl: $('sideControl'),
  eloRange: $('eloRange'),
  eloValue: $('eloValue'),
  rangeMarks: $('rangeMarks'),
  continuousToggle: $('continuousToggle'),
  ttsToggle: $('ttsToggle'),
  ttsVoiceSelect: $('ttsVoiceSelect'),
  ttsTestBtn: $('ttsTestBtn'),
  ttsHint: $('ttsHint'),
  modelSelect: $('modelSelect'),
  serverHint: $('serverHint'),
  commandGroups: $('commandGroups'),
  aiOnly: Array.from(document.querySelectorAll('[data-ai-only]')),

  promotionModal: $('promotionModal'),
  promoChoices: $('promoChoices'),
  promotionClose: $('promotionClose'),

  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmText: $('confirmText'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),

  gameOverModal: $('gameOverModal'),
  resultTitle: $('resultTitle'),
  resultReason: $('resultReason'),
  resultEmblem: $('resultEmblem'),
  rematchBtn: $('rematchBtn'),
  closeResultBtn: $('closeResultBtn'),

  toasts: $('toasts'),
};

const state = {
  game: new Chess(START_FEN),
  startFen: START_FEN,
  moves: [],
  selected: null,
  orientation: 'w',
  mode: 'ai',
  elo: DEFAULT_ELO,
  humanColor: 'w',
  staticMode: STATIC_MODE,
  lang: 'pt',
  tts: true,
  ttsVoice: 'F',
  sound: true,
  continuous: false,
  model: 'base',
  server: { state: 'checking', available: false, models: [], engine: null, lastError: '', tts: { state: 'loading', available: false } },
  status: null,
  gameOver: false,
  endStatus: null,
  ended: false,
  endTimer: null,
  resigned: false,
  thinking: false,
  aiPurpose: null,
  aiToken: 0,
  aiTimer: null,
  worker: null,
  pendingPromotion: null,
  hintMove: null,
  lastMove: null,
  evalCp: 0,
  sessionActive: false,
  voiceState: 'idle',
  voiceProcessing: false,
  narrating: false,
  lastSpeech: Promise.resolve(),
  lastSource: null,
  healthBusy: false,
  healthTimer: null,
  lastHealthAttempt: 0,
};

let sounds = null;
let narrator = null;
let voice = null;
let narrToken = 0;
let confirmResolve = null;

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  if (['ai', '2p'].includes(saved.mode)) state.mode = saved.mode;
  if (Number.isFinite(Number(saved.elo))) state.elo = configForElo(saved.elo).elo;
  else if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= 5) state.elo = eloForLevel(saved.level);
  if (['w', 'b'].includes(saved.humanColor)) state.humanColor = saved.humanColor;
  if (['pt', 'en'].includes(saved.lang)) state.lang = saved.lang;
  if (typeof saved.tts === 'boolean') state.tts = saved.tts;
  if (saved.ttsVoice === 'F' || saved.ttsVoice === 'M') state.ttsVoice = saved.ttsVoice;
  if (typeof saved.sound === 'boolean') state.sound = saved.sound;
  if (typeof saved.continuous === 'boolean') state.continuous = saved.continuous;
  if (['small', 'base', 'medium', 'tiny'].includes(saved.model)) state.model = saved.model;
  state.orientation = state.mode === 'ai' ? state.humanColor : 'w';
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: state.mode,
      elo: state.elo,
      humanColor: state.humanColor,
      lang: state.lang,
      tts: state.tts,
      ttsVoice: state.ttsVoice,
      sound: state.sound,
      continuous: state.continuous,
      model: state.model,
    }));
  } catch {
    /* storage may be unavailable */
  }
}

function init() {
  loadSettings();
  buildMeter();
  sounds = new Sounds(state.sound);
  narrator = new Narrator({ lang: state.lang, enabled: state.tts, ttsVoice: state.ttsVoice });
  voice = new VoiceInput({
    onState: handleVoiceState,
    onLevel: handleVoiceLevel,
    getLang: () => state.lang,
    getModel: () => state.model,
    serverAvailable: false,
  });
  bindEvents();
  applyLanguage();
  syncSettingsUI();
  renderServer();
  newGame({ silent: true });
  if (STATIC_MODE) {
    state.server = {
      state: 'static',
      available: false,
      models: [],
      engine: 'browser',
      lastError: '',
      tts: { state: 'unavailable', available: false },
    };
    if (voice) voice.setServerAvailable(false);
    if (narrator) narrator.setServerTts(false);
    renderServer();
    updateMicUI();
  } else {
    checkHealth();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function humanColorInt() {
  return colorInt(state.humanColor);
}

function isHumanTurn() {
  return state.mode === '2p' || state.game.turn === humanColorInt();
}

function aiColor() {
  return state.mode === 'ai' && state.humanColor === 'w' ? 'b' : 'w';
}

function currentStatus() {
  if (state.gameOver && state.endStatus) return state.endStatus;
  return state.game.status();
}

function reasonLabel(status) {
  if (!status) return '';
  const map = {
    checkmate: 'reasonCheckmate',
    stalemate: 'reasonStalemate',
    fifty: 'reasonFifty',
    repetition: 'reasonRepetition',
    material: 'reasonMaterial',
    resign: 'reasonResign',
  };
  return map[status.reason] ? t(state.lang, map[status.reason]) : '';
}

function resultTitleFor(status) {
  if (!status) return '';
  if (status.draw) return t(state.lang, 'resultDraw');
  if (state.mode === '2p') {
    return status.winner === WHITE ? t(state.lang, 'resultWhiteWins') : t(state.lang, 'resultBlackWins');
  }
  return status.winner === humanColorInt() ? t(state.lang, 'resultWin') : t(state.lang, 'resultLose');
}

function movesLabel(count) {
  if (state.lang === 'en') return `${count} ${count === 1 ? 'move' : 'moves'}`;
  return `${count} ${count === 1 ? 'lance' : 'lances'}`;
}

function evalLabelText() {
  const pawns = clamp(state.evalCp / 100, -20, 20);
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

function pieceAtName(square) {
  return state.game.pieceAt(square);
}

function pieceColorAt(square) {
  const piece = pieceAtName(square);
  if (!piece) return null;
  return piece > 0 ? 'w' : 'b';
}

function ownPieceAt(square) {
  const color = pieceColorAt(square);
  return color === colorLetter(state.game.turn);
}

function entryForMove(move, { san } = {}) {
  const from = moveFrom(move);
  const to = moveTo(move);
  const flags = moveFlags(move);
  const promo = movePromotion(move);
  const capturedSq = flags & FLAG_EP ? to - 16 * state.game.turn : to;
  const captured = Math.abs(state.game.board[capturedSq]) || 0;
  const piece = Math.abs(state.game.board[from]) || PAWN;
  return {
    uci: moveToUci(move),
    san: san ?? state.game.moveToSan(move),
    from: sqToName(from),
    to: sqToName(to),
    piece: TYPE_TO_LETTER[piece],
    capture: !!(flags & FLAG_CAPTURE),
    captured: captured ? TYPE_TO_LETTER[captured] : null,
    promotion: promo ? TYPE_TO_LETTER[promo] : null,
    castle: flags & FLAG_KCASTLE ? 'k' : flags & FLAG_QCASTLE ? 'q' : null,
    color: colorLetter(state.game.turn),
  };
}

function legalMovesFromTo(from, to) {
  return state.game.generateMoves(false).filter(
    (move) => sqToName(moveFrom(move)) === from && sqToName(moveTo(move)) === to,
  );
}

function isPromotionMove(move) {
  return movePromotion(move) > 0;
}

/* -------------------------------------------------------------------------- */
/* Board rendering                                                             */
/* -------------------------------------------------------------------------- */

function visualCoords(square) {
  const index = nameToSq(square);
  const file = index & 7;
  const rank = index >> 4;
  if (state.orientation === 'w') return { col: file, row: 7 - rank };
  return { col: 7 - file, row: rank };
}

function renderBoard(animate = false) {
  const status = state.status || currentStatus();
  const legalTargets = new Map();
  if (state.selected && isHumanTurn() && !status.over) {
    for (const move of state.game.generateMoves(false)) {
      if (sqToName(moveFrom(move)) !== state.selected) continue;
      const target = sqToName(moveTo(move));
      const capture = !!(moveFlags(move) & FLAG_CAPTURE);
      legalTargets.set(target, (legalTargets.get(target) || false) || capture);
    }
  }
  const checkSquare = status.check
    ? sqToName(state.game.kings[state.game.turn === WHITE ? 0 : 1])
    : null;

  const squareFragment = document.createDocumentFragment();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = state.orientation === 'w' ? 7 - row : row;
      const file = state.orientation === 'w' ? col : 7 - col;
      const square = sqToName(rank * 16 + file);
      const light = (file + rank) % 2 === 1;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `square ${light ? 'light' : 'dark'}`;
      button.dataset.sq = square;
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', square);

      if (state.lastMove && (state.lastMove.from === square || state.lastMove.to === square)) {
        button.classList.add('last');
      }
      if (state.selected === square) button.classList.add('selected');
      if (state.hintMove && (state.hintMove.from === square || state.hintMove.to === square)) {
        button.classList.add(state.hintMove.from === square ? 'hint-from' : 'hint-to');
      }
      if (checkSquare === square) button.classList.add('check');
      if (legalTargets.has(square)) {
        button.classList.add(legalTargets.get(square) ? 'legal-capture' : 'legal');
      }

      if (col === 0) {
        const rankLabel = document.createElement('span');
        rankLabel.className = 'coord coord-rank';
        rankLabel.textContent = String(rank + 1);
        button.appendChild(rankLabel);
      }
      if (row === 7) {
        const fileLabel = document.createElement('span');
        fileLabel.className = 'coord coord-file';
        fileLabel.textContent = 'abcdefgh'[file];
        button.appendChild(fileLabel);
      }
      squareFragment.appendChild(button);
    }
  }
  dom.squares.replaceChildren(squareFragment);

  const pieceFragment = document.createDocumentFragment();
  const pieceEls = new Map();
  for (let square = 0; square < 128; square++) {
    if (square & 0x88) continue;
    const piece = state.game.board[square];
    if (!piece) continue;
    const name = sqToName(square);
    const { col, row } = visualCoords(name);
    const el = document.createElement('div');
    el.className = 'piece';
    el.dataset.sq = name;
    el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    el.style.backgroundImage = `url("${PIECE_IMG(piece > 0 ? 'w' : 'b', TYPE_TO_LETTER[Math.abs(piece)])}")`;
    pieceFragment.appendChild(el);
    pieceEls.set(name, el);
  }
  dom.pieces.replaceChildren(pieceFragment);

  if (animate && state.lastMove) animateLastMove(pieceEls);
}

function animateLastMove(pieceEls) {
  const entry = state.lastMove;
  if (!entry) return;
  const animatePiece = (from, to) => {
    const el = pieceEls.get(to);
    if (!el) return;
    const fromCoords = visualCoords(from);
    const toCoords = visualCoords(to);
    const dx = (fromCoords.col - toCoords.col) * 100;
    const dy = (fromCoords.row - toCoords.row) * 100;
    if (!dx && !dy) return;
    const base = `translate(${toCoords.col * 100}%, ${toCoords.row * 100}%)`;
    try {
      el.animate(
        [
          { transform: `${base} translate(${dx}%, ${dy}%)` },
          { transform: base },
        ],
        { duration: 230, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    } catch {
      /* Web Animations unavailable */
    }
  };

  animatePiece(entry.from, entry.to);
  if (entry.castle === 'k' || entry.castle === 'q') {
    const rank = entry.color === 'w' ? '1' : '8';
    if (entry.castle === 'k') animatePiece(`h${rank}`, `f${rank}`);
    else animatePiece(`a${rank}`, `d${rank}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Players, status, eval, moves                                                */
/* -------------------------------------------------------------------------- */

function capturedLists() {
  const result = { w: [], b: [] };
  for (const move of state.moves) {
    if (move.captured) result[move.color].push(move.captured);
  }
  result.w.sort((a, b) => (PIECE_VALUE[b] || 0) - (PIECE_VALUE[a] || 0));
  result.b.sort((a, b) => (PIECE_VALUE[b] || 0) - (PIECE_VALUE[a] || 0));
  return result;
}

function materialValue(list) {
  return list.reduce((sum, piece) => sum + (PIECE_VALUE[piece] || 0), 0);
}

function renderPlayerCard(which, color) {
  const top = which === 'top';
  const colorName = color === 'w' ? t(state.lang, 'white') : t(state.lang, 'black');
  const isAi = state.mode === 'ai' && color === aiColor();
  const name = state.mode === '2p' ? colorName : isAi ? t(state.lang, 'ai') : t(state.lang, 'you');
  const sub = state.mode === '2p'
    ? `${colorName} · ${t(state.lang, 'twoPlayers')}`
    : isAi ? `${colorName} · Elo ${state.elo}` : colorName;

  const nameEl = top ? dom.topName : dom.bottomName;
  const subEl = top ? dom.topSub : dom.bottomSub;
  const avatarEl = top ? dom.topAvatar : dom.bottomAvatar;
  const capturedEl = top ? dom.topCaptured : dom.bottomCaptured;
  const advEl = top ? dom.topAdv : dom.bottomAdv;
  const card = top ? dom.topCard : dom.bottomCard;

  nameEl.textContent = name;
  subEl.textContent = sub;
  avatarEl.src = PIECE_IMG(color, 'K');

  const caps = capturedLists();
  const captured = color === 'w' ? caps.w : caps.b;
  const capturedFragment = document.createDocumentFragment();
  const enemyColor = color === 'w' ? 'b' : 'w';
  for (const pieceLetter of captured) {
    const img = document.createElement('img');
    img.src = PIECE_IMG(enemyColor, pieceLetter);
    img.alt = PIECE_NAMES[state.lang === 'en' ? 'en' : 'pt'][pieceLetter] || pieceLetter;
    capturedFragment.appendChild(img);
  }
  capturedEl.replaceChildren(capturedFragment);

  const diff = materialValue(caps.w) - materialValue(caps.b);
  const advantage = color === 'w' ? diff : -diff;
  advEl.textContent = advantage > 0
    ? t(state.lang, 'materialAdvantage', { n: advantage })
    : '';

  const status = state.status || currentStatus();
  const active = !status.over && colorLetter(state.game.turn) === color;
  card.classList.toggle('active', active);
  card.classList.toggle('thinking', state.thinking && isAi);
}

function renderPlayers() {
  const topColor = state.orientation === 'w' ? 'b' : 'w';
  const bottomColor = state.orientation === 'w' ? 'w' : 'b';
  renderPlayerCard('top', topColor);
  renderPlayerCard('bottom', bottomColor);
}

function renderStatus() {
  const status = state.status || currentStatus();
  const dot = dom.turnDot;
  dot.className = 'turn-dot';
  if (status.over) {
    dom.statusText.textContent = resultTitleFor(status);
    dom.statusSub.textContent = `${reasonLabel(status)} · ${movesLabel(state.moves.length)}`;
    return;
  }

  if (status.check) {
    dot.classList.add(colorLetter(state.game.turn));
    dom.statusText.textContent = `${state.game.turn === WHITE ? t(state.lang, 'turnWhite') : t(state.lang, 'turnBlack')} · ${t(state.lang, 'check')}`;
  } else {
    dot.classList.add(colorLetter(state.game.turn));
    dom.statusText.textContent = state.thinking
      ? t(state.lang, 'aiThinking')
      : (state.game.turn === WHITE ? t(state.lang, 'turnWhite') : t(state.lang, 'turnBlack'));
  }
  dom.statusSub.textContent = state.mode === 'ai'
    ? `${t(state.lang, 'vsAi')} · Elo ${state.elo}`
    : t(state.lang, 'twoPlayers');
}

function renderEval() {
  const status = state.status || currentStatus();
  let ratio;
  if (status.over) {
    if (status.draw) ratio = 0.5;
    else ratio = status.winner === WHITE ? 0.97 : 0.03;
  } else {
    ratio = 1 / (1 + Math.exp(-state.evalCp / 320));
  }
  dom.evalWhite.style.height = `${(clamp(ratio, 0.03, 0.97) * 100).toFixed(1)}%`;
  dom.evalRail.title = `${t(state.lang, 'evalLabel')}: ${evalLabelText()}`;
}

function renderMoveList() {
  const fragment = document.createDocumentFragment();
  if (!state.moves.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t(state.lang, 'noMoves');
    fragment.appendChild(li);
  } else {
    for (let i = 0; i < state.moves.length; i += 2) {
      const li = document.createElement('li');
      li.className = 'move-row';
      const number = document.createElement('span');
      number.className = 'num';
      number.textContent = `${i / 2 + 1}.`;
      li.appendChild(number);
      for (let j = 0; j < 2; j++) {
        const move = state.moves[i + j];
        const span = document.createElement('span');
        span.className = 'san';
        if (move) {
          span.textContent = move.san;
          if (i + j === state.moves.length - 1) span.classList.add('last');
        }
        li.appendChild(span);
      }
      fragment.appendChild(li);
    }
  }
  if (state.status && state.status.over) {
    const li = document.createElement('li');
    li.className = 'move-row result';
    li.textContent = `${resultTitleFor(state.status)} · ${reasonLabel(state.status)}`;
    fragment.appendChild(li);
  }
  dom.moveList.replaceChildren(fragment);
  dom.moveList.scrollTop = dom.moveList.scrollHeight;
  dom.moveCount.textContent = movesLabel(state.moves.length);
}

function updateBoardBusy() {
  dom.boardBusy.classList.toggle('on', state.thinking);
  const label = dom.boardBusy.querySelector('span:last-child');
  if (label) label.textContent = t(state.lang, 'thinking');
}

function renderAll({ animate = false } = {}) {
  const status = currentStatus();
  state.status = status;
  if (status.over) {
    state.gameOver = true;
    if (!state.endStatus) state.endStatus = status;
  }
  renderBoard(animate);
  renderPlayers();
  renderStatus();
  renderMoveList();
  renderEval();
  renderVoiceMeta();
  updateControls();
  updateBoardBusy();
  updateMicUI();
}

function updateControls() {
  const status = state.status || currentStatus();
  dom.undoBtn.disabled = state.moves.length === 0;
  dom.hintBtn.disabled = !!(status.over || state.thinking || !isHumanTurn() || state.pendingPromotion);
  dom.resignBtn.disabled = !!status.over;
  dom.micBtn.disabled = !!status.over;
  dom.micBtn.setAttribute('aria-pressed', String(state.sessionActive));
}

/* -------------------------------------------------------------------------- */
/* Moves                                                                       */
/* -------------------------------------------------------------------------- */

function stopNarration() {
  narrToken++;
  state.narrating = false;
  if (narrator) narrator.cancel();
}

function narrate(text) {
  if (!text) return Promise.resolve();
  const token = ++narrToken;
  if (!state.tts || !narrator) {
    state.lastSpeech = Promise.resolve();
    return state.lastSpeech;
  }
  if (state.sessionActive && voice) {
    voice.stop({ release: false });
  }
  state.narrating = true;
  const promise = narrator.speak(text).finally(() => {
    if (token === narrToken) state.narrating = false;
  });
  state.lastSpeech = promise;
  return promise;
}

function playMoveByInt(move, { source = 'click' } = {}) {
  const game = state.game;
  const from = moveFrom(move);
  const to = moveTo(move);
  const flags = moveFlags(move);
  const promo = movePromotion(move);
  const capturedSq = flags & FLAG_EP ? to - 16 * game.turn : to;
  const captured = Math.abs(game.board[capturedSq]) || 0;
  const piece = Math.abs(game.board[from]) || PAWN;
  const color = colorLetter(game.turn);
  const san = game.moveToSan(move);
  game.makeMove(move);

  const entry = {
    uci: moveToUci(move),
    san,
    from: sqToName(from),
    to: sqToName(to),
    piece: TYPE_TO_LETTER[piece],
    capture: !!(flags & FLAG_CAPTURE),
    captured: captured ? TYPE_TO_LETTER[captured] : null,
    promotion: promo ? TYPE_TO_LETTER[promo] : null,
    castle: flags & FLAG_KCASTLE ? 'k' : flags & FLAG_QCASTLE ? 'q' : null,
    color,
    source,
  };
  state.moves.push(entry);
  state.lastMove = entry;
  state.selected = null;
  state.hintMove = null;
  state.pendingPromotion = null;
  hidePromotionModal();

  const status = game.status();
  state.status = status;

  if (status.over) {
    state.gameOver = true;
    state.endStatus = status;
  } else if (status.check) {
    sounds.play('check');
  } else if (flags & (FLAG_KCASTLE | FLAG_QCASTLE)) {
    sounds.play('castle');
  } else if (captured) {
    sounds.play('capture');
  } else {
    sounds.play('move');
  }

  renderAll({ animate: true });

  if (status.over) {
    endGame(status);
  }
  return { entry, status };
}

function afterHumanMove() {
  if (state.mode !== 'ai' || state.gameOver) return;
  if (state.game.turn === humanColorInt()) return;
  scheduleAI(300);
}

async function applyMoveAndReport(move, { source = 'voice' } = {}) {
  const { entry, status } = playMoveByInt(move, { source });
  const description = describeMove(entry, state.lang);
  showFeedback(`${t(state.lang, 'moveApplied')}: ${description}`, 'success');
  if (status.over) {
    await state.lastSpeech;
    return;
  }
  await narrate(description);
  afterHumanMove();
}

async function applyParsedMove(parsed) {
  if (state.pendingPromotion) return;
  const moves = legalMovesFromTo(parsed.from, parsed.to);
  if (!moves.length) {
    const message = t(state.lang, 'illegalMove');
    showFeedback(message, 'error');
    sounds.play('error');
    await narrate(message);
    return;
  }

  let chosen = null;
  if (parsed.promotion && LETTER_TO_TYPE[parsed.promotion]) {
    chosen = moves.find((move) => movePromotion(move) === LETTER_TO_TYPE[parsed.promotion]) || null;
  } else {
    const promos = moves.filter(isPromotionMove);
    if (promos.length === moves.length && moves.length > 1) {
      openPromotion(parsed.from, parsed.to);
      const message = t(state.lang, 'promotionNeeded');
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    chosen = moves[0];
  }

  if (!chosen) {
    const message = t(state.lang, 'illegalMove');
    showFeedback(message, 'error');
    sounds.play('error');
    await narrate(message);
    return;
  }
  await applyMoveAndReport(chosen, { source: 'voice' });
}

function openPromotion(from, to) {
  const moves = state.game.generateMoves(false).filter(
    (move) => sqToName(moveFrom(move)) === from && sqToName(moveTo(move)) === to && isPromotionMove(move),
  );
  if (!moves.length) return false;
  state.pendingPromotion = { from, to, moves, color: colorLetter(state.game.turn) };
  renderPromotionChoices();
  dom.promotionModal.classList.remove('hidden');
  const first = dom.promoChoices.querySelector('button');
  if (first) first.focus({ preventScroll: true });
  return true;
}

function renderPromotionChoices() {
  const pending = state.pendingPromotion;
  if (!pending) return;
  const fragment = document.createDocumentFragment();
  const labels = {
    Q: 'chooseQueen',
    R: 'chooseRook',
    B: 'chooseBishop',
    N: 'chooseKnight',
  };
  for (const letter of PROMO_ORDER) {
    const move = pending.moves.find((m) => movePromotion(m) === LETTER_TO_TYPE[letter]);
    if (!move) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'promo-choice';
    button.dataset.piece = letter;
    const img = document.createElement('img');
    img.src = PIECE_IMG(pending.color, letter);
    img.alt = '';
    const span = document.createElement('span');
    span.textContent = t(state.lang, labels[letter]);
    button.append(img, span);
    fragment.appendChild(button);
  }
  dom.promoChoices.replaceChildren(fragment);
}

function hidePromotionModal() {
  dom.promotionModal.classList.add('hidden');
}

function closePromotion() {
  const from = state.pendingPromotion ? state.pendingPromotion.from : null;
  state.pendingPromotion = null;
  hidePromotionModal();
  if (from) state.selected = from;
  renderAll();
}

async function applyPromotion(letter) {
  if (!state.pendingPromotion) return;
  const pending = state.pendingPromotion;
  const pieceType = LETTER_TO_TYPE[letter];
  if (!pieceType) return;
  const move = pending.moves.find((m) => movePromotion(m) === pieceType);
  if (!move) return;
  state.pendingPromotion = null;
  hidePromotionModal();
  const { entry, status } = playMoveByInt(move, { source: 'promotion' });
  const description = describeMove(entry, state.lang);
  showFeedback(`${t(state.lang, 'moveApplied')}: ${description}`, 'success');
  if (status.over) {
    await state.lastSpeech;
    return;
  }
  await narrate(description);
  afterHumanMove();
}

/* -------------------------------------------------------------------------- */
/* Click interaction                                                           */
/* -------------------------------------------------------------------------- */

function onSquareClick(square) {
  if (state.pendingPromotion) return;
  if (!humanTurnGuard()) return;

  const status = state.status || currentStatus();
  if (status.over) {
    const message = t(state.lang, 'gameAlreadyOver');
    showFeedback(message, 'info');
    return;
  }

  stopNarration();
  const own = ownPieceAt(square);

  if (state.selected) {
    if (state.selected === square) {
      state.selected = null;
      renderAll();
      return;
    }
    const moves = legalMovesFromTo(state.selected, square);
    if (moves.length) {
      const promos = moves.filter(isPromotionMove);
      if (promos.length === moves.length && moves.length > 1) {
        openPromotion(state.selected, square);
        showFeedback(t(state.lang, 'promotionNeeded'), 'info');
        return;
      }
      const result = playMoveByInt(moves[0], { source: 'click' });
      if (!result.status.over) {
        if (result.status.check) narrate(t(state.lang, 'check'));
        afterHumanMove();
      }
      return;
    }
    if (own) {
      state.selected = square;
      state.hintMove = null;
      sounds.play('notify');
      renderAll();
      return;
    }
    state.selected = null;
    renderAll();
    return;
  }

  if (own) {
    state.selected = square;
    state.hintMove = null;
    sounds.play('notify');
    renderAll();
  }
}

function humanTurnGuard() {
  if (state.mode === '2p') return true;
  if (state.game.turn === humanColorInt()) return true;
  const message = state.thinking ? t(state.lang, 'aiThinking') : t(state.lang, 'notYourTurn');
  showFeedback(message, 'error');
  return false;
}

/* -------------------------------------------------------------------------- */
/* Game lifecycle                                                              */
/* -------------------------------------------------------------------------- */

function newGame({ silent = false } = {}) {
  cancelAI();
  if (state.sessionActive && voice) voice.stop({ release: false });
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
  if (confirmResolve) finishConfirm(false);
  state.game = new Chess(START_FEN);
  state.startFen = START_FEN;
  state.moves = [];
  state.selected = null;
  state.lastMove = null;
  state.hintMove = null;
  state.pendingPromotion = null;
  state.gameOver = false;
  state.endStatus = null;
  state.ended = false;
  state.resigned = false;
  state.evalCp = 0;
  state.status = null;
  hidePromotionModal();
  dom.gameOverModal.classList.add('hidden');
  dom.confirmModal.classList.add('hidden');
  confirmResolve = null;
  state.orientation = state.mode === 'ai' ? state.humanColor : 'w';
  renderAll();
  if (!silent) {
    showFeedback(t(state.lang, 'newGameStarted'), 'info');
    sounds.play('notify');
  }
  if (state.mode === 'ai' && state.game.turn !== humanColorInt()) {
    scheduleAI(450);
  }
}

function undoMove() {
  if (!state.moves.length) {
    showFeedback(t(state.lang, 'noUndo'), 'error');
    return false;
  }
  cancelAI();
  stopNarration();
  if (state.sessionActive && voice) voice.stop({ release: false });
  if (state.endTimer) {
    clearTimeout(state.endTimer);
    state.endTimer = null;
  }
  state.gameOver = false;
  state.endStatus = null;
  state.ended = false;
  state.resigned = false;
  state.pendingPromotion = null;
  hidePromotionModal();
  dom.gameOverModal.classList.add('hidden');

  let undone = 0;
  if (state.mode === 'ai') {
    do {
      if (!state.game.undo()) break;
      state.moves.pop();
      undone++;
    } while (state.moves.length && state.game.turn !== humanColorInt());
  } else if (state.game.undo()) {
    state.moves.pop();
    undone++;
  }

  state.selected = null;
  state.hintMove = null;
  state.lastMove = state.moves.length ? state.moves[state.moves.length - 1] : null;
  state.evalCp = 0;
  state.status = null;
  renderAll();
  showFeedback(t(state.lang, 'undoDone'), 'info');
  sounds.play('notify');
  if (state.mode === 'ai' && state.game.turn !== humanColorInt()) scheduleAI(400);
  return undone > 0;
}

function resignGame(loserColor) {
  if (state.gameOver) return;
  cancelAI();
  const loser = loserColor || (state.mode === 'ai' ? state.humanColor : colorLetter(state.game.turn));
  const winner = loser === 'w' ? 'b' : 'w';
  const status = {
    over: true,
    check: false,
    checkmate: false,
    stalemate: false,
    draw: false,
    winner: colorInt(winner),
    reason: 'resign',
    legalMoves: [],
  };
  state.gameOver = true;
  state.endStatus = status;
  state.ended = false;
  state.status = status;
  renderAll();
  endGame(status);
}

function endGame(status) {
  if (state.ended) return;
  state.ended = true;
  state.thinking = false;
  state.aiPurpose = null;
  state.sessionActive = false;
  if (voice) voice.stop({ release: true });
  if (state.aiTimer) {
    clearTimeout(state.aiTimer);
    state.aiTimer = null;
  }
  if (state.worker) {
    try { state.worker.terminate(); } catch { /* ignore */ }
    state.worker = null;
  }
  sounds.play('end');

  const title = resultTitleFor(status);
  const reason = reasonLabel(status);
  const speech = reason ? `${title} ${reason}.` : title;
  state.lastSpeech = narrate(speech);

  if (state.endTimer) clearTimeout(state.endTimer);
  state.endTimer = setTimeout(() => {
    if (state.endStatus === status) showResultModal(status);
  }, 550);
  updateMicUI();
}

function showResultModal(status) {
  const title = resultTitleFor(status);
  const reason = reasonLabel(status);
  dom.resultTitle.textContent = title;
  dom.resultReason.textContent = `${reason} · ${movesLabel(state.moves.length)}`;
  dom.resultEmblem.className = 'result-emblem';
  if (status.draw) {
    dom.resultEmblem.textContent = '½';
    dom.resultEmblem.classList.add('draw');
  } else {
    dom.resultEmblem.textContent = status.winner === WHITE ? '♔' : '♚';
    if (state.mode === 'ai' && status.winner !== humanColorInt()) dom.resultEmblem.classList.add('lose');
  }
  dom.gameOverModal.classList.remove('hidden');
}

function closeResultModal() {
  dom.gameOverModal.classList.add('hidden');
}

function askConfirm(title, text, okLabel) {
  if (confirmResolve) finishConfirm(false);
  dom.confirmTitle.textContent = title;
  dom.confirmText.textContent = text;
  dom.confirmOk.textContent = okLabel;
  dom.confirmModal.classList.remove('hidden');
  dom.confirmCancel.focus({ preventScroll: true });
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function finishConfirm(value) {
  dom.confirmModal.classList.add('hidden');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(value);
}

/* -------------------------------------------------------------------------- */
/* AI worker                                                                   */
/* -------------------------------------------------------------------------- */

function ensureWorker() {
  if (state.worker) return state.worker;
  try {
    const worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (event) => {
      console.error('AI worker error', event);
      state.thinking = false;
      state.aiPurpose = null;
      state.worker = null;
      updateBoardBusy();
      showFeedback(t(state.lang, 'engineError'), 'error');
      renderAll();
    };
    state.worker = worker;
    return worker;
  } catch (error) {
    console.error(error);
    showFeedback(t(state.lang, 'engineError'), 'error');
    return null;
  }
}

function cancelAI() {
  if (state.aiTimer) {
    clearTimeout(state.aiTimer);
    state.aiTimer = null;
  }
  state.aiToken++;
  state.thinking = false;
  state.aiPurpose = null;
  if (state.worker) {
    try { state.worker.terminate(); } catch { /* ignore */ }
    state.worker = null;
  }
  updateBoardBusy();
}

function scheduleAI(delay = 280) {
  if (state.mode !== 'ai' || state.gameOver) return;
  if (state.game.turn === humanColorInt()) return;
  if (state.thinking) return;
  if (state.aiTimer) clearTimeout(state.aiTimer);
  state.thinking = true;
  if (state.sessionActive && voice) voice.stop({ release: false });
  updateBoardBusy();
  renderStatus();
  renderPlayers();
  updateControls();
  state.aiTimer = setTimeout(() => {
    state.aiTimer = null;
    startAIThink();
  }, delay);
}

function startAIThink() {
  if (state.mode !== 'ai' || state.gameOver) return;
  if (state.game.turn === humanColorInt()) return;
  const worker = ensureWorker();
  if (!worker) return;
  state.thinking = true;
  state.aiPurpose = 'move';
  state.aiToken++;
  const id = state.aiToken;
  updateBoardBusy();
  renderStatus();
  renderPlayers();
  updateControls();
  try {
    const config = configForElo(state.elo);
    worker.postMessage({
      type: 'think',
      id,
      startFen: state.startFen,
      moves: state.moves.map((move) => move.uci),
      level: config.level,
      timeMs: config.timeMs,
      maxDepth: config.maxDepth,
      blunder: config.blunder,
      book: config.book,
    });
  } catch (error) {
    console.error(error);
    state.thinking = false;
    state.aiPurpose = null;
    updateBoardBusy();
    showFeedback(t(state.lang, 'engineError'), 'error');
    renderAll();
  }
}

function updateEvalFromResult(result, turnSide) {
  if (typeof result.score !== 'number') return;
  let score = result.score;
  if (Math.abs(score) > 30000) score = Math.sign(score) * 2000;
  const whiteScore = turnSide === WHITE ? score : -score;
  state.evalCp = clamp(whiteScore, -2000, 2000);
}

async function onWorkerMessage(event) {
  const data = event.data || {};
  if (data.type === 'error') {
    state.thinking = false;
    state.aiPurpose = null;
    updateBoardBusy();
    showFeedback(`${t(state.lang, 'engineError')} ${data.message || ''}`.trim(), 'error');
    renderAll();
    return;
  }
  if (data.id !== state.aiToken) return;

  const purpose = state.aiPurpose;
  state.thinking = false;
  state.aiPurpose = null;
  updateBoardBusy();

  if (purpose === 'hint') {
    await handleHintResult(data);
    return;
  }

  if (!data.move) {
    renderAll();
    showFeedback(t(state.lang, 'hintNotFound'), 'error');
    return;
  }
  const move = state.game.findMoveByUci(data.move);
  if (!move) {
    renderAll();
    showFeedback(t(state.lang, 'illegalMove'), 'error');
    return;
  }
  updateEvalFromResult(data, state.game.turn);
  const { entry, status } = playMoveByInt(move, { source: 'ai' });
  if (status.over) {
    await state.lastSpeech;
    return;
  }
  await narrate(describeMove(entry, state.lang));
  updateMicUI();
}

async function requestHint() {
  if (state.thinking || state.gameOver) return;
  if (!humanTurnGuard()) return;
  const worker = ensureWorker();
  if (!worker) return;
  state.thinking = true;
  state.aiPurpose = 'hint';
  state.aiToken++;
  const id = state.aiToken;
  if (state.sessionActive && voice) voice.stop({ release: false });
  showFeedback(t(state.lang, 'requestingHint'), 'info');
  updateBoardBusy();
  renderStatus();
  renderPlayers();
  updateControls();
  try {
    worker.postMessage({
      type: 'think',
      id,
      startFen: state.startFen,
      moves: state.moves.map((move) => move.uci),
      level: 4,
      timeMs: 1300,
      maxDepth: 10,
      book: false,
      allowBlunder: false,
    });
  } catch (error) {
    console.error(error);
    state.thinking = false;
    state.aiPurpose = null;
    updateBoardBusy();
    showFeedback(t(state.lang, 'engineError'), 'error');
    renderAll();
  }
}

async function handleHintResult(data) {
  if (!data.move) {
    showFeedback(t(state.lang, 'hintNotFound'), 'error');
    renderAll();
    return;
  }
  const move = state.game.findMoveByUci(data.move);
  if (!move) {
    showFeedback(t(state.lang, 'hintNotFound'), 'error');
    renderAll();
    return;
  }
  updateEvalFromResult(data, state.game.turn);
  const entry = entryForMove(move);
  state.hintMove = { from: entry.from, to: entry.to };
  state.selected = null;
  renderAll();
  const message = t(state.lang, 'hintReady', { move: describeMove(entry, state.lang) });
  showFeedback(message, 'info');
  sounds.play('notify');
  await narrate(message);
}

/* -------------------------------------------------------------------------- */
/* Command processing                                                          */
/* -------------------------------------------------------------------------- */

function buildParserContext() {
  const board = {};
  for (let square = 0; square < 128; square++) {
    if (square & 0x88) continue;
    const piece = state.game.board[square];
    if (!piece) continue;
    board[sqToName(square)] = `${piece > 0 ? 'w' : 'b'}${TYPE_TO_LETTER[Math.abs(piece)]}`;
  }
  const moves = state.game.generateMoves(false).map((move) => {
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);
    const promo = movePromotion(move);
    return {
      from: sqToName(from),
      to: sqToName(to),
      piece: TYPE_TO_LETTER[Math.abs(state.game.board[from])],
      promotion: promo ? TYPE_TO_LETTER[promo] : null,
      capture: !!(flags & FLAG_CAPTURE),
      castle: flags & FLAG_KCASTLE ? 'k' : flags & FLAG_QCASTLE ? 'q' : null,
    };
  });
  return {
    turn: colorLetter(state.game.turn),
    moves,
    board,
    selected: state.selected,
  };
}

function directMoveFromText(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > 24) return null;
  if (trimmed.split(/\s+/).length > 4) return null;
  return state.game.matchSan(trimmed);
}

function parseErrorMessage(parsed) {
  const reason = parsed.reason;
  if (reason === 'no_legal_move') {
    return t(state.lang, 'noLegalMove', { from: parsed.from || '?', to: parsed.to || '?' });
  }
  if (reason === 'no_piece') {
    return t(state.lang, 'noPieceAt', { square: parsed.from || parsed.to || '?' });
  }
  if (reason === 'no_capture_available') {
    return t(state.lang, 'noCapture', { square: parsed.to || '?' });
  }
  if (reason === 'squares_missing') return t(state.lang, 'squaresMissing');
  if (reason === 'promotion_piece_unknown') return t(state.lang, 'promotionPieceUnknown');
  return `${t(state.lang, 'notUnderstood')} ${t(state.lang, 'tryExample')}`;
}

async function processCommand(text) {
  if (!text) return;

  if (state.gameOver) {
    const isControl = /(nova partida|novo jogo|new game|reiniciar|recomecar|restart|reset|desfazer|undo|situacao|status|repete|repetir|repeat|girar|virar|flip)/i.test(text);
    if (!isControl) {
      const message = t(state.lang, 'gameAlreadyOver');
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
  }

  if (state.pendingPromotion) {
    const promo = parsePromotionPiece(text);
    if (promo) {
      await applyPromotion(promo);
      return;
    }
    if (/\b(cancelar|cancel|fechar|close)\b/i.test(text)) {
      closePromotion();
      return;
    }
    const message = t(state.lang, 'promotionPending');
    showFeedback(message, 'error');
    await narrate(message);
    return;
  }

  const direct = directMoveFromText(text);
  if (direct) {
    if (!humanTurnGuard()) return;
    await applyMoveAndReport(direct, { source: 'voice' });
    return;
  }

  const parsed = parseCommand(text, buildParserContext());
  switch (parsed.type) {
    case 'move': {
      if (!humanTurnGuard()) return;
      await applyParsedMove(parsed);
      return;
    }
    case 'select': {
      if (!humanTurnGuard()) return;
      state.selected = parsed.square;
      state.hintMove = null;
      renderAll();
      sounds.play('notify');
      const message = `${t(state.lang, 'pieceSelected', { square: parsed.square })} ${t(state.lang, 'sayDestination')}`;
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    case 'ambiguous': {
      const target = parsed.target || parsed.to || '';
      const sources = (parsed.candidates || []).map((candidate) => candidate.from).filter((v, i, arr) => arr.indexOf(v) === i);
      const message = `${t(state.lang, 'ambiguousText', { square: target })} ${t(state.lang, 'selectSource', { squares: sources.join(', ') })}`;
      showFeedback(message, 'error');
      sounds.play('error');
      await narrate(message);
      return;
    }
    case 'needsPromotion': {
      if (!humanTurnGuard()) return;
      if (!parsed.from) {
        showFeedback(t(state.lang, 'promotionPending'), 'info');
        return;
      }
      openPromotion(parsed.from, parsed.to);
      const message = t(state.lang, 'promotionNeeded');
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    case 'promotionChoice': {
      const message = t(state.lang, 'promotionPending');
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    case 'action':
      await handleAction(parsed);
      return;
    case 'invalid':
    default: {
      const message = parseErrorMessage(parsed);
      showFeedback(message, 'error');
      sounds.play('error');
      await narrate(message);
    }
  }
}

async function handleAction(parsed) {
  switch (parsed.action) {
    case 'castle': {
      if (!humanTurnGuard()) return;
      const castles = state.game.generateMoves(false).filter(
        (move) => moveFlags(move) & (FLAG_KCASTLE | FLAG_QCASTLE),
      );
      if (!castles.length) {
        const message = t(state.lang, 'castleUnavailable');
        showFeedback(message, 'error');
        sounds.play('error');
        await narrate(message);
        return;
      }
      let chosen = null;
      if (parsed.side === 'k') {
        chosen = castles.find((move) => moveFlags(move) & FLAG_KCASTLE);
      } else if (parsed.side === 'q') {
        chosen = castles.find((move) => moveFlags(move) & FLAG_QCASTLE);
      } else if (castles.length === 1) {
        chosen = castles[0];
      }
      if (!chosen) {
        const message = t(state.lang, 'castleSideQuestion');
        showFeedback(message, 'info');
        await narrate(message);
        return;
      }
      await applyMoveAndReport(chosen, { source: 'voice' });
      return;
    }
    case 'new': {
      newGame();
      const message = t(state.lang, 'newGameStarted');
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    case 'undo': {
      const done = undoMove();
      if (done) await narrate(t(state.lang, 'undoDone'));
      return;
    }
    case 'hint': {
      if (!humanTurnGuard()) return;
      await requestHint();
      return;
    }
    case 'flip': {
      state.orientation = state.orientation === 'w' ? 'b' : 'w';
      state.selected = null;
      renderAll();
      showFeedback(t(state.lang, 'flip'), 'info');
      return;
    }
    case 'resign': {
      doResign();
      return;
    }
    case 'status': {
      const message = statusSpeech();
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    case 'repeat': {
      const last = state.moves[state.moves.length - 1];
      const message = last ? describeMove(last, state.lang) : t(state.lang, 'noMoves');
      showFeedback(message, 'info');
      await narrate(message);
      return;
    }
    default:
      return;
  }
}

function statusSpeech() {
  const status = state.status || currentStatus();
  if (status.over) {
    return `${resultTitleFor(status)} ${reasonLabel(status)}.`;
  }
  const side = state.game.turn === WHITE ? t(state.lang, 'white') : t(state.lang, 'black');
  const base = t(state.lang, status.check ? 'statusCheck' : 'statusTurn', { side });
  return `${base} ${t(state.lang, 'statusEval', { value: evalLabelText() })}`;
}

function doResign() {
  if (state.gameOver) return;
  state.ended = false;
  resignGame();
}

async function handleUtterance(text, source = 'typed', meta = {}) {
  if (!text) return;
  state.voiceProcessing = true;
  updateMicUI();
  setTranscript(text, source);
  stopNarration();
  try {
    await processCommand(text);
  } catch (error) {
    console.error('Command failed', error);
    const message = t(state.lang, 'notUnderstood');
    showFeedback(message, 'error');
  } finally {
    state.voiceProcessing = false;
    updateMicUI();
  }
}

/* -------------------------------------------------------------------------- */
/* Voice session                                                               */
/* -------------------------------------------------------------------------- */

function buildMeter() {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 23; i++) {
    const bar = document.createElement('span');
    bar.style.transform = `scaleY(${(0.08 + (i % 4) * 0.05).toFixed(3)})`;
    fragment.appendChild(bar);
  }
  dom.meter.replaceChildren(fragment);
  dom.meter.classList.add('idle');
}

function setMeter(level) {
  const bars = dom.meter.children;
  if (!bars.length) return;
  const phase = performance.now() / 110;
  for (let i = 0; i < bars.length; i++) {
    const wave = 0.28 + 0.72 * Math.abs(Math.sin(i * 0.78 + phase));
    const value = clamp(0.06 + level * 1.8 * wave, 0.06, 1);
    bars[i].style.transform = `scaleY(${value.toFixed(3)})`;
  }
}

function handleVoiceState(voiceState) {
  state.voiceState = voiceState;
  if (voiceState === 'idle') setMeter(0);
  updateMicUI();
}

function handleVoiceLevel(level) {
  if (!state.sessionActive) return;
  setMeter(level);
}

function updateMicUI() {
  if (!voice) return;
  const vs = state.voiceState;
  dom.micBtn.classList.toggle('is-listening', state.sessionActive && vs === 'listening');
  dom.micBtn.classList.toggle('is-recording', state.sessionActive && vs === 'recording');
  dom.micBtn.classList.toggle('is-processing', vs === 'processing');
  dom.micBtn.classList.toggle('is-idle', !state.sessionActive);
  dom.micFloat.classList.toggle('is-listening', state.sessionActive && vs === 'listening');
  dom.micFloat.classList.toggle('is-recording', state.sessionActive && vs === 'recording');
  dom.micFloat.classList.toggle('is-processing', vs === 'processing');
  dom.meter.classList.toggle('idle', !(state.sessionActive && (vs === 'listening' || vs === 'recording')));
  dom.voiceState.classList.toggle('busy', vs === 'processing' || state.voiceProcessing);

  let text = t(state.lang, 'micIdle');
  if (vs === 'processing') text = t(state.lang, 'micProcessing');
  else if (state.sessionActive && vs === 'recording') text = t(state.lang, 'micRecording');
  else if (state.sessionActive && vs === 'listening') text = t(state.lang, 'micListening');
  else if (state.sessionActive) text = t(state.lang, 'micAuto');
  dom.voiceState.textContent = text;
  dom.micBtn.title = text;
  dom.micBtn.setAttribute('aria-pressed', String(state.sessionActive));
  dom.micBtn.disabled = !!(state.status && state.status.over);
  if (!dom.micBtn.disabled) dom.micBtn.removeAttribute('disabled');
  else dom.micBtn.setAttribute('disabled', 'disabled');

  dom.micFloat.title = text;
  dom.micFloat.setAttribute('aria-pressed', String(state.sessionActive));
  dom.micFloat.disabled = dom.micBtn.disabled;

  const langName = state.lang === 'en' ? 'English' : 'Português';
  let source;
  if (state.server.available) {
    source = `${t(state.lang, 'sourceWhisper')} ${modelShortName(state.model)}`;
  } else if (state.server.state === 'checking') {
    source = t(state.lang, 'serverChecking');
  } else if (voice.browserSupported()) {
    source = t(state.lang, 'sourceBrowserCloud');
  } else {
    source = t(state.lang, 'serverOffline');
  }
  dom.voiceSub.textContent = `${langName} · ${source}`;
}

function canListen() {
  if (!state.sessionActive) return false;
  if (state.gameOver) return false;
  if (state.thinking || state.narrating || state.voiceProcessing) return false;
  if (!isHumanTurn()) return false;
  if (document.visibilityState === 'hidden') return false;
  return true;
}

async function startVoiceSession() {
  if (state.sessionActive) return;
  if (state.gameOver) {
    showFeedback(t(state.lang, 'gameAlreadyOver'), 'info');
    return;
  }
  const status = state.status || currentStatus();
  if (status.over) return;
  if (!state.server.available && !voice.browserSupported()) {
    showFeedback(t(state.lang, STATIC_MODE ? 'browserNotSupported' : 'serverUnavailable'), 'error');
    if (!STATIC_MODE) checkHealth();
    return;
  }
  stopNarration();
  state.sessionActive = true;
  updateMicUI();
  runVoiceSession();
}

function stopVoiceSession() {
  state.sessionActive = false;
  if (voice) voice.stop({ release: true });
  updateMicUI();
}

function toggleVoiceSession() {
  if (state.sessionActive) stopVoiceSession();
  else startVoiceSession();
}

async function listenWithBrowserOnce() {
  const started = performance.now();
  let text;
  try {
    text = await voice.recognizeWithBrowser(state.lang);
  } catch (error) {
    voice.stop({ release: false });
    throw error;
  }
  voice.stop({ release: false });
  const clean = String(text || '').trim();
  if (!clean) {
    const error = new Error('Empty transcription');
    error.code = 'empty';
    throw error;
  }
  return { text: clean, source: 'browser', ms: Math.round(performance.now() - started) };
}

async function runVoiceSession() {
  try {
    while (state.sessionActive) {
      if (!canListen()) {
        await sleep(220);
        continue;
      }
      let result = null;
      try {
        result = STATIC_MODE
          ? await listenWithBrowserOnce()
          : await voice.listenOnce({ continuous: state.continuous });
      } catch (error) {
        if (!state.sessionActive) break;
        handleVoiceError(error);
        const retryable = state.continuous && ['no_speech', 'empty'].includes(error.code);
        if (!retryable) break;
        await sleep(600);
        continue;
      }
      if (!state.sessionActive) break;
      if (result && result.text) {
        await handleUtterance(result.text, result.source, result);
        if (!state.continuous) break;
        await sleep(250);
      }
    }
  } finally {
    state.sessionActive = false;
    if (voice) voice.stop({ release: true });
    updateMicUI();
  }
}

function handleVoiceError(error) {
  const code = error && error.code;
  const map = {
    not_allowed: 'micDenied',
    no_mic: 'noMic',
    no_speech: 'noSpeech',
    empty: 'noSpeech',
    transcribe_failed: 'transcribeFailed',
    server_error: 'transcribeFailed',
    server_offline: 'serverUnavailable',
    timeout: 'transcribeFailed',
    bad_response: 'transcribeFailed',
    no_browser_stt: 'browserNotSupported',
    browser_stt_failed: 'transcribeFailed',
  };
  const key = map[code] || 'transcribeFailed';
  const hard = ['not_allowed', 'no_mic'].includes(code);
  const info = ['no_speech', 'empty'].includes(code) && state.continuous;
  showFeedback(t(state.lang, key), info ? 'info' : 'error');
  sounds.play(info ? 'notify' : 'error');
  if (!info) narrate(t(state.lang, key));
  if (['server_error', 'server_offline', 'transcribe_failed', 'timeout', 'bad_response'].includes(code)) {
    if (!STATIC_MODE) checkHealth();
  }
  if (hard) {
    state.sessionActive = false;
    if (voice) voice.release();
  }
  updateMicUI();
}

/* -------------------------------------------------------------------------- */
/* Transcript and feedback                                                     */
/* -------------------------------------------------------------------------- */

function setTranscript(text, source = 'typed') {
  state.lastSource = source;
  dom.transcriptText.textContent = text || '—';
  const tag = dom.transcriptSource;
  tag.classList.remove('hidden', 'browser', 'typed');
  if (!source) {
    tag.classList.add('hidden');
    return;
  }
  if (source === 'browser') {
    tag.textContent = t(state.lang, 'sourceBrowserCloud');
    tag.classList.add('browser');
  } else if (source === 'typed') {
    tag.textContent = t(state.lang, 'sourceTyped');
    tag.classList.add('typed');
  } else {
    tag.textContent = t(state.lang, 'sourceWhisper');
  }
}

function showFeedback(message, type = 'info') {
  dom.feedback.textContent = message;
  dom.feedback.className = `feedback ${type}`;
  dom.feedback.classList.remove('hidden');
}

function clearFeedback() {
  dom.feedback.textContent = '';
  dom.feedback.classList.add('hidden');
}

function showToast(message, type = 'info') {
  if (!message) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toasts.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 280);
  }, 4200);
}

/* -------------------------------------------------------------------------- */
/* Server and settings                                                         */
/* -------------------------------------------------------------------------- */

function modelShortName(id) {
  const names = { small: 'Small', base: 'Base', medium: 'Medium', tiny: 'Tiny', large: 'Large' };
  return names[id] || (id ? id[0].toUpperCase() + id.slice(1) : '—');
}

async function checkHealth() {
  if (state.healthBusy) return;
  state.healthBusy = true;
  state.healthTimer = null;
  const previousState = state.server.state;
  state.server.state = 'checking';
  renderServer();
  updateMicUI();

  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      let data = null;
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      } catch {
        if (attempt < 2) {
          await sleep(1400);
          continue;
        }
        state.server = {
          state: 'offline',
          available: false,
          models: [],
          engine: null,
          lastError: '',
          tts: { state: 'unavailable', available: false },
        };
        if (voice) voice.setServerAvailable(false);
        if (narrator) narrator.setServerTts(false);
        renderServer();
        updateMicUI();
        return;
      }

      const models = Array.isArray(data.models) ? data.models : [];
      const tts = data.tts && typeof data.tts === 'object'
        ? data.tts
        : { state: data.ttsAvailable ? 'ready' : 'unavailable', available: !!data.ttsAvailable };
      state.server = {
        state: data.state || 'ready',
        available: !!data.whisperAvailable,
        models,
        engine: data.engine || null,
        lastError: data.lastError || '',
        model: data.model || null,
        tts,
      };
      if (voice) voice.setServerAvailable(state.server.available);
      if (narrator) narrator.setServerTts(!!tts.available);
      populateModels(models, data.defaultModel);
      renderServer();
      updateMicUI();
      if (data.state === 'loading' || data.state === 'starting' || tts.state === 'loading') {
        await sleep(1800);
        continue;
      }
      return;
    }
  } finally {
    state.healthBusy = false;
    state.lastHealthAttempt = Date.now();
    if (state.server.state === 'offline' && previousState !== 'offline') {
      showToast(t(state.lang, 'serverUnavailable'), 'error');
    }
  }
}

function populateModels(models, defaultModel) {
  if (!Array.isArray(models) || !models.length) return;
  const seen = new Set();
  const options = [];
  for (const model of models) {
    if (!model || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    const variant = model.variant ? ` · ${model.variant}` : '';
    const size = model.sizeMb ? ` · ${model.sizeMb} MB` : '';
    const localized = model.id === 'base'
      ? t(state.lang, 'modelFast')
      : model.id === 'small'
        ? t(state.lang, 'modelRecommended')
        : modelShortName(model.id);
    options.push({ value: model.id, label: `${localized}${variant}${size}` });
  }
  const fragment = document.createDocumentFragment();
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    fragment.appendChild(el);
  }
  dom.modelSelect.replaceChildren(fragment);
  const values = options.map((option) => option.value);
  if (!values.includes(state.model)) {
    state.model = values.includes(defaultModel) ? defaultModel : values[0];
    saveSettings();
  }
  dom.modelSelect.value = state.model;
}

function renderServer() {
  if (STATIC_MODE) {
    if (narrator) narrator.setServerTts(false);
    dom.engineDot.className = 'engine-dot static';
    dom.engineStatusText.textContent = t(state.lang, 'staticModeShort');
    dom.engineStatus.title = t(state.lang, 'staticServerHint');
    dom.voiceBadge.classList.add('offline');
    dom.voiceBadge.textContent = voice && voice.browserSupported()
      ? t(state.lang, 'sourceBrowserCloud')
      : t(state.lang, 'serverOffline');
    dom.serverHint.className = 'hint';
    dom.serverHint.textContent = t(state.lang, 'staticServerHint');
    dom.modelSelect.disabled = true;
    renderTtsHint();
    return;
  }
  if (state.server.models && state.server.models.length) {
    populateModels(state.server.models, state.model);
  }
  const available = state.server.available;
  const loading = ['checking', 'loading', 'starting'].includes(state.server.state);
  dom.engineDot.className = 'engine-dot';
  if (available && !loading) dom.engineDot.classList.add('online');
  else if (loading) dom.engineDot.classList.add('loading');
  else dom.engineDot.classList.add('offline');

  if (available) {
    dom.engineStatusText.textContent = `${t(state.lang, 'sourceWhisper')} ${modelShortName(state.model)}`;
  } else if (loading) {
    dom.engineStatusText.textContent = t(state.lang, 'serverChecking');
  } else {
    dom.engineStatusText.textContent = t(state.lang, 'serverOffline');
  }
  dom.engineStatus.title = state.server.lastError || dom.engineStatusText.textContent;

  dom.voiceBadge.classList.toggle('offline', !available);
  if (available) {
    dom.voiceBadge.textContent = `${t(state.lang, 'sourceWhisper')} ${modelShortName(state.model)}`;
  } else if (loading) {
    dom.voiceBadge.textContent = `${t(state.lang, 'sourceWhisper')}…`;
  } else if (voice && voice.browserSupported()) {
    dom.voiceBadge.textContent = t(state.lang, 'sourceBrowserCloud');
  } else {
    dom.voiceBadge.textContent = t(state.lang, 'serverOffline');
  }

  dom.serverHint.className = 'hint';
  dom.modelSelect.disabled = !available;
  if (available) {
    const variant = state.server.models.find((model) => model.id === state.model);
    dom.serverHint.classList.add('online');
    dom.serverHint.textContent = `${t(state.lang, 'serverOnline')} · ${modelShortName(state.model)}${state.server.engine === 'cli' ? ' (CLI)' : ''}${variant && variant.sizeMb ? ` · ${variant.sizeMb} MB` : ''}`;
  } else if (loading) {
    dom.serverHint.textContent = t(state.lang, 'serverChecking');
  } else {
    dom.serverHint.classList.add('error');
    dom.serverHint.textContent = state.server.lastError
      ? `${t(state.lang, 'serverOffline')} · ${state.server.lastError}`
      : t(state.lang, 'serverOffline');
  }
  if (!dom.modelSelect.options.length) {
    dom.modelSelect.innerHTML = '<option value="small">Small</option><option value="base">Base</option>';
  }
  if (Array.from(dom.modelSelect.options).some((opt) => opt.value === state.model)) {
    dom.modelSelect.value = state.model;
  }
  renderTtsHint();
}

function renderTtsHint() {
  if (!dom.ttsHint) return;
  const tts = state.server.tts || { state: 'unavailable', available: false };
  dom.ttsHint.className = 'hint';
  dom.ttsHint.title = tts.error || '';
  if (STATIC_MODE) {
    dom.ttsHint.title = t(state.lang, 'staticTtsHint');
    if (!state.tts) {
      dom.ttsHint.textContent = t(state.lang, 'ttsOff');
    } else if (state.lang === 'en') {
      dom.ttsHint.textContent = t(state.lang, 'ttsEnglish');
    } else {
      dom.ttsHint.textContent = t(state.lang, 'staticTtsHint');
    }
    dom.ttsVoiceSelect.value = state.ttsVoice;
    dom.ttsVoiceSelect.disabled = true;
    return;
  }
  if (!state.tts) {
    dom.ttsHint.textContent = t(state.lang, 'ttsOff');
  } else if (state.lang === 'en') {
    dom.ttsHint.textContent = t(state.lang, 'ttsEnglish');
  } else if (tts.available) {
    const voice = state.ttsVoice === 'M' ? t(state.lang, 'voiceMale') : t(state.lang, 'voiceFemale');
    dom.ttsHint.classList.add('online');
    dom.ttsHint.textContent = `${t(state.lang, 'ttsLocal')} · ${voice}`;
  } else if (tts.state === 'loading' || state.server.state === 'checking' || state.server.state === 'loading') {
    dom.ttsHint.textContent = t(state.lang, 'ttsLoading');
  } else {
    dom.ttsHint.classList.add('error');
    dom.ttsHint.textContent = t(state.lang, 'ttsFallback');
  }
  if (dom.ttsVoiceSelect) {
    dom.ttsVoiceSelect.value = state.ttsVoice;
    dom.ttsVoiceSelect.disabled = !tts.available;
  }
}

function testVoice() {
  if (!narrator) return;
  if (state.sessionActive && voice) voice.stop({ release: false });
  const sample = state.lang === 'en' ? t(state.lang, 'ttsSampleEn') : t(state.lang, 'ttsSample');
  const token = ++narrToken;
  state.narrating = true;
  updateMicUI();
  showFeedback(t(state.lang, 'testVoice'), 'info');
  narrator.speak(sample, { force: true }).finally(() => {
    if (token === narrToken) state.narrating = false;
    updateMicUI();
  });
}

function renderVoiceMeta() {
  const available = state.server.available;
  dom.voiceBadge.classList.toggle('offline', !available);
  if (available) {
    dom.voiceBadge.textContent = `${t(state.lang, 'sourceWhisper')} ${modelShortName(state.model)}`;
  } else if (['checking', 'loading', 'starting'].includes(state.server.state)) {
    dom.voiceBadge.textContent = `${t(state.lang, 'sourceWhisper')}…`;
  } else if (voice && voice.browserSupported()) {
    dom.voiceBadge.textContent = t(state.lang, 'sourceBrowserCloud');
  } else {
    dom.voiceBadge.textContent = t(state.lang, 'serverOffline');
  }
}

function syncSettingsUI() {
  for (const button of dom.modeControl.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.value === state.mode);
  }
  for (const button of dom.sideControl.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.value === state.humanColor);
  }
  for (const button of dom.langControl.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.value === state.lang);
  }
  for (const button of dom.langSwitch.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.lang === state.lang);
  }
  for (const element of dom.aiOnly) {
    element.classList.toggle('hidden', state.mode !== 'ai');
  }
  dom.eloRange.value = String(state.elo);
  const eloTier = t(state.lang, 'levelNames')[levelForElo(state.elo)] || '';
  dom.eloValue.textContent = `${state.elo} · ${eloTier}`;
  dom.eloRange.setAttribute('aria-valuetext', `${state.elo} · ${eloTier}`);
  dom.rangeMarks.textContent = `${ELO_MIN} ${t(state.lang, 'levelNames')[1]} — ${ELO_MAX} ${t(state.lang, 'levelNames')[5]}`;
  dom.continuousToggle.checked = state.continuous;
  dom.ttsToggle.checked = state.tts;
  dom.ttsVoiceSelect.value = state.ttsVoice;
  if (dom.modelSelect.options.length) dom.modelSelect.value = state.model;
  dom.soundBtn.classList.toggle('off', !state.sound && !state.tts);
  dom.helpBtn.title = t(state.lang, 'commandsTab');
  dom.micBtn.setAttribute('aria-label', t(state.lang, 'voiceTitle'));
  dom.micFloat.setAttribute('aria-label', t(state.lang, 'voiceTitle'));
  dom.micFloat.title = t(state.lang, 'micIdle');
  renderTtsHint();
}

/* -------------------------------------------------------------------------- */
/* i18n UI                                                                     */
/* -------------------------------------------------------------------------- */

function applyLanguage() {
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'pt-BR';
  document.title = t(state.lang, 'appName');
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const key = element.dataset.i18n;
    const value = t(state.lang, key);
    if (typeof value === 'string') element.textContent = value;
  }
  for (const element of document.querySelectorAll('[data-i18n-ph]')) {
    element.placeholder = t(state.lang, element.dataset.i18nPh);
  }
  for (const element of document.querySelectorAll('[data-title-key]')) {
    element.title = t(state.lang, element.dataset.titleKey);
  }
  dom.textInput.placeholder = t(state.lang, 'textPlaceholder');
  dom.promotionClose.setAttribute('aria-label', t(state.lang, 'close'));
  dom.closeResultBtn.textContent = t(state.lang, 'close');
  dom.rematchBtn.textContent = t(state.lang, 'rematch');
  dom.confirmCancel.textContent = t(state.lang, 'cancel');

  generateExampleChips();
  generateCommandGroups();
  if (narrator) narrator.setLang(state.lang);
  syncSettingsUI();
  renderServer();
  renderAll();
  if (state.pendingPromotion) renderPromotionChoices();
  if (state.endStatus && !dom.gameOverModal.classList.contains('hidden')) {
    showResultModal(state.endStatus);
  }
}

function generateExampleChips() {
  const examples = STRINGS[state.lang === 'en' ? 'en' : 'pt'].examples || [];
  const fragment = document.createDocumentFragment();
  for (const example of examples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.cmd = example;
    button.textContent = example;
    fragment.appendChild(button);
  }
  dom.exampleChips.replaceChildren(fragment);
}

function generateCommandGroups() {
  const table = STRINGS[state.lang === 'en' ? 'en' : 'pt'];
  const groups = table.commandGroups || [];
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    const wrapper = document.createElement('div');
    wrapper.className = 'command-group';
    const title = document.createElement('h3');
    title.textContent = group.title;
    wrapper.appendChild(title);
    for (const [command, description] of group.rows) {
      const row = document.createElement('div');
      row.className = 'command-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'command-example';
      button.dataset.cmd = command;
      button.textContent = command;
      const span = document.createElement('span');
      span.textContent = description;
      row.append(button, span);
      wrapper.appendChild(row);
    }
    fragment.appendChild(wrapper);
  }
  dom.commandGroups.replaceChildren(fragment);
}

/* -------------------------------------------------------------------------- */
/* Misc actions                                                                */
/* -------------------------------------------------------------------------- */

function submitCommand(command) {
  const text = String(command || '').trim();
  if (!text) return;
  if (voice && state.sessionActive) voice.stop({ release: false });
  dom.textInput.value = '';
  handleUtterance(text, 'typed');
}

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
  }
  if (name === 'commands' && window.innerWidth <= 980) {
    document.querySelector('.sidebar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleSound() {
  const turnOn = !(state.sound || state.tts);
  state.sound = turnOn;
  state.tts = turnOn;
  sounds.setEnabled(turnOn);
  narrator.setEnabled(turnOn);
  if (!turnOn) stopNarration();
  saveSettings();
  syncSettingsUI();
  showToast(t(state.lang, turnOn ? 'soundOn' : 'soundOff'), turnOn ? 'success' : 'info');
}

async function copyText(text, successKey) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(t(state.lang, successKey), 'success');
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      showToast(t(state.lang, successKey), 'success');
    } catch {
      showToast(t(state.lang, 'copyFailed'), 'error');
    }
  }
}

function pgnResult() {
  if (!state.status || !state.status.over) return '*';
  if (state.status.draw) return '1/2-1/2';
  return state.status.winner === WHITE ? '1-0' : '0-1';
}

function buildPgn() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateString = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  const whiteName = state.mode === '2p'
    ? (state.lang === 'en' ? 'White' : 'Brancas')
    : (state.humanColor === 'w' ? 'Player' : 'AI');
  const blackName = state.mode === '2p'
    ? (state.lang === 'en' ? 'Black' : 'Pretas')
    : (state.humanColor === 'b' ? 'Player' : 'AI');
  const headers = [
    '[Event "Xadrez Voz"]',
    '[Site "Local"]',
    `[Date "${dateString}"]`,
    '[Round "-"]',
    `[White "${whiteName}"]`,
    `[Black "${blackName}"]`,
    `[Result "${pgnResult()}"]`,
  ];
  const tokens = [];
  for (let i = 0; i < state.moves.length; i += 2) {
    tokens.push(`${i / 2 + 1}.`);
    tokens.push(state.moves[i].san);
    if (state.moves[i + 1]) tokens.push(state.moves[i + 1].san);
  }
  tokens.push(pgnResult());
  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (line.length + token.length + 1 > 78) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  return `${headers.join('\n')}\n\n${lines.join('\n')}\n`;
}

async function requestResign() {
  if (state.gameOver) return;
  const confirmed = await askConfirm(
    t(state.lang, 'resignTitle'),
    t(state.lang, 'resignText'),
    t(state.lang, 'confirmResign'),
  );
  if (!confirmed) return;
  doResign();
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  dom.board.addEventListener('click', (event) => {
    const square = event.target.closest('.square');
    if (!square) return;
    onSquareClick(square.dataset.sq);
  });

  dom.newBtn.addEventListener('click', () => {
    stopNarration();
    newGame();
  });
  dom.undoBtn.addEventListener('click', () => {
    undoMove();
  });
  dom.flipBtn.addEventListener('click', () => {
    state.orientation = state.orientation === 'w' ? 'b' : 'w';
    state.selected = null;
    renderAll();
    sounds.play('notify');
  });
  dom.hintBtn.addEventListener('click', () => {
    requestHint();
  });
  dom.resignBtn.addEventListener('click', () => {
    requestResign();
  });
  dom.soundBtn.addEventListener('click', toggleSound);
  dom.helpBtn.addEventListener('click', () => showTab('commands'));
  dom.engineStatus.addEventListener('click', () => {
    if (!STATIC_MODE && !state.healthBusy) checkHealth();
  });

  dom.micBtn.addEventListener('click', toggleVoiceSession);
  dom.micFloat.addEventListener('click', toggleVoiceSession);

  dom.textForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCommand(dom.textInput.value);
  });

  dom.exampleChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cmd]');
    if (!button) return;
    submitCommand(button.dataset.cmd);
  });
  dom.commandGroups.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cmd]');
    if (!button) return;
    submitCommand(button.dataset.cmd);
  });

  dom.langSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (button) setLanguage(button.dataset.lang);
  });
  dom.langControl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-value]');
    if (button) setLanguage(button.dataset.value);
  });

  dom.modeControl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-value]');
    if (!button || button.dataset.value === state.mode) return;
    state.mode = button.dataset.value;
    saveSettings();
    syncSettingsUI();
    newGame();
    showToast(t(state.lang, 'newGameStarted'), 'info');
  });

  dom.sideControl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-value]');
    if (!button || button.dataset.value === state.humanColor) return;
    state.humanColor = button.dataset.value;
    saveSettings();
    syncSettingsUI();
    newGame();
    showToast(t(state.lang, 'newGameStarted'), 'info');
  });

  dom.eloRange.addEventListener('input', () => {
    state.elo = configForElo(dom.eloRange.value).elo;
    saveSettings();
    syncSettingsUI();
    renderPlayers();
    renderStatus();
  });

  dom.continuousToggle.addEventListener('change', () => {
    state.continuous = dom.continuousToggle.checked;
    saveSettings();
    if (!state.continuous && state.sessionActive) stopVoiceSession();
    updateMicUI();
  });

  dom.ttsToggle.addEventListener('change', () => {
    state.tts = dom.ttsToggle.checked;
    narrator.setEnabled(state.tts);
    if (!state.tts) stopNarration();
    saveSettings();
    syncSettingsUI();
  });

  dom.ttsVoiceSelect.addEventListener('change', () => {
    state.ttsVoice = dom.ttsVoiceSelect.value === 'M' ? 'M' : 'F';
    narrator.setTtsVoice(state.ttsVoice);
    saveSettings();
    renderTtsHint();
  });

  dom.ttsTestBtn.addEventListener('click', testVoice);

  dom.modelSelect.addEventListener('change', () => {
    state.model = dom.modelSelect.value;
    saveSettings();
    renderServer();
    updateMicUI();
    showToast(`${t(state.lang, 'whisperModel')}: ${modelShortName(state.model)}`, 'info');
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.copy === 'pgn') copyText(buildPgn(), 'pgnCopied');
      else copyText(state.game.fen(), 'fenCopied');
    });
  });

  dom.promoChoices.addEventListener('click', (event) => {
    const button = event.target.closest('[data-piece]');
    if (!button) return;
    applyPromotion(button.dataset.piece);
  });
  dom.promotionClose.addEventListener('click', closePromotion);

  dom.confirmCancel.addEventListener('click', () => finishConfirm(false));
  dom.confirmOk.addEventListener('click', () => finishConfirm(true));
  dom.confirmModal.addEventListener('click', (event) => {
    if (event.target === dom.confirmModal) finishConfirm(false);
  });

  dom.closeResultBtn.addEventListener('click', closeResultModal);
  dom.rematchBtn.addEventListener('click', () => {
    closeResultModal();
    newGame();
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const editable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (event.key === 'Escape') {
      if (!dom.confirmModal.classList.contains('hidden')) {
        finishConfirm(false);
      } else if (!dom.promotionModal.classList.contains('hidden')) {
        closePromotion();
      } else if (!dom.gameOverModal.classList.contains('hidden')) {
        closeResultModal();
      }
      return;
    }
    if (!editable && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      if (!dom.promotionModal.classList.contains('hidden')) return;
      toggleVoiceSession();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.sessionActive && voice) {
      voice.stop({ release: false });
    }
  });
}

function setLanguage(lang) {
  if (!['pt', 'en'].includes(lang) || lang === state.lang) return;
  state.lang = lang;
  saveSettings();
  stopNarration();
  if (narrator) narrator.setLang(lang);
  applyLanguage();
  if (state.lastSource) setTranscript(dom.transcriptText.textContent, state.lastSource);
  updateMicUI();
}

/* -------------------------------------------------------------------------- */
/* Start                                                                       */
/* -------------------------------------------------------------------------- */

init();
