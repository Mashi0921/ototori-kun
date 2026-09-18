/**
 * 音取りくん — マルチトラック完全同期再生 + マイクピッチ検出 + ノート単位評価
 *
 * 同期設計の核心:
 *   - Tone.Transport を唯一の時間基準とする
 *   - 各 Player は .sync().start(0) のみ使用（個別 start/seek 禁止）
 *   - シーク = pause → Transport.seconds 変更 → start
 *
 * iPad Safari 注意点:
 *   - AudioContext は必ずユーザー操作のコールバック内で resume する (Tone.start())
 *   - <Audio> タグは使用しない（Web Audio API に統一）
 *   - range input には touch-action: none が必要な場合あり（CSS で設定済み）
 *   - requestAnimationFrame は setInterval より精度が安定
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as Tone from 'tone';

// ── トラック定義 ──────────────────────────────────────────────────────────────
const TRACKS = [
  { id: 'soprano',       label: 'ソプラノ' },
  { id: 'alto',          label: 'アルト' },
  { id: 'accompaniment', label: '伴奏' },
];

const INITIAL_VOLUMES = Object.fromEntries(TRACKS.map(t => [t.id, 0]));

// ── 難易度定義 ────────────────────────────────────────────────────────────────
const DIFFICULTIES = [
  { id: 'easy',   label: '★', tolerance: 1.5 },
  { id: 'normal', label: '★★', tolerance: 1.0 },
  { id: 'hard',   label: '★★★', tolerance: 0.5 },
];

// ── 五線譜座標系定数 ──────────────────────────────────────────────────────────
const STAFF_CONFIG = {
  svgWidth: 160,
  svgHeight: 180,
  lineSpacing: 20,        // 五線間の距離（px）
  baseY: 100,             // E4 の基準Y座標
  yPixelPerStep: 10,      // 1ステップあたりのpx（白鍵密度）
  staffLineY: [20, 40, 60, 80, 100],  // 五線のY座標（上から順）
  noteCircleRadius: 6,    // 黒丸のサイズ
  stemLength: 24,         // 符幹の長さ
  stemWidth: 2,           // 符幹の太さ
  stemStdDev: 12,         // 符幹の水平オフセット
  referenceNote: { octave: 4, noteIndex: 2, position: 0 },  // E4
};

// ── 白鍵マッピングテーブル ────────────────────────────────────────────────────
const WHITE_KEY_MAP = {
  0: 0,    // C
  2: 1,    // D
  4: 2,    // E
  5: 3,    // F
  7: 4,    // G
  9: 5,    // A
  11: 6,   // B
};

const IS_BLACK_KEY = (noteInOctave) => ![0, 2, 4, 5, 7, 9, 11].includes(noteInOctave);

// ── 異名同音マッピング ────────────────────────────────────────────────────────
const ENHARMONIC_MAP = {
  1: {  // C# / D♭
    note1: { midi: 0, name: 'ド', accidental: '♯' },
    note2: { midi: 2, name: 'レ', accidental: '♭' }
  },
  3: {  // D# / E♭
    note1: { midi: 2, name: 'レ', accidental: '♯' },
    note2: { midi: 4, name: 'ミ', accidental: '♭' }
  },
  6: {  // F# / G♭
    note1: { midi: 5, name: 'ファ', accidental: '♯' },
    note2: { midi: 7, name: 'ソ', accidental: '♭' }
  },
  8: {  // G# / A♭
    note1: { midi: 7, name: 'ソ', accidental: '♯' },
    note2: { midi: 9, name: 'ラ', accidental: '♭' }
  },
  10: {  // A# / B♭
    note1: { midi: 9, name: 'ラ', accidental: '♯' },
    note2: { midi: 11, name: 'シ', accidental: '♭' }
  }
};

// ── 白鍵の音名テーブル ────────────────────────────────────────────────────────
const WHITE_KEY_NAMES = {
  0: 'ド',
  2: 'レ',
  4: 'ミ',
  5: 'ファ',
  7: 'ソ',
  9: 'ラ',
  11: 'シ',
};

// ── ユーティリティ ────────────────────────────────────────────────────────────
const formatTime = (sec) => {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// ── 中央80%平均を計算 ────────────────────────────────────────────────────────
function calculateTrimmedMean(values) {
  if (values.length === 0) return 0;
  if (values.length < 10) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(values.length * 0.1);
  const trimmed = sorted.slice(trimCount, values.length - trimCount);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

// ── MIDI値から五線上の位置を計算（改善版） ────────────────────────────────────
function getMidiPosition(midi) {
  if (midi === null || midi === undefined) return null;

  const octave = Math.floor(midi / 12) - 1;
  const noteInOctave = midi % 12;

  const noteIndex = WHITE_KEY_MAP[noteInOctave];
  if (noteIndex === undefined) return null; // 黒鍵は対応なし

  const refConfig = STAFF_CONFIG.referenceNote;
  const position = (octave - refConfig.octave) * 7 + (noteIndex - refConfig.noteIndex);
  
  return position;
}

// ── MIDI値からY座標を計算 ────────────────────────────────────────────────────
function getMidiY(midi) {
  const position = getMidiPosition(midi);
  if (position === null) return null;
  return STAFF_CONFIG.baseY - position * STAFF_CONFIG.yPixelPerStep;
}

// ── 符幹の方向を決定（下向き: true, 上向き: false） ──────────────────────────
function isStemDown(midi) {
  const position = getMidiPosition(midi);
  if (position === null) return true;  // 不正な場合はデフォルト下向き
  return position > 4; // B4（position=4）より上なら下向き
}

// ── 符幹のX座標を計算 ────────────────────────────────────────────────────────
function getStemX(cx, midi) {
  const stemDown = isStemDown(midi);
  return stemDown ? (cx - STAFF_CONFIG.stemStdDev) : (cx + STAFF_CONFIG.stemStdDev);
}

// ── 符幹のY座標範囲を計算 ────────────────────────────────────────────────────
function getStemYRange(midi, noteY) {
  const stemDown = isStemDown(midi);
  if (stemDown) {
    // 下向き：丸の中央から下へ（Y値が増える）
    return {
      y1: noteY,
      y2: noteY + STAFF_CONFIG.stemLength
    };
  } else {
    // 上向き：丸の中央から上へ（Y値が減る）
    return {
      y1: noteY,
      y2: noteY - STAFF_CONFIG.stemLength
    };
  }
}

// ── 黒鍵の異名同音を取得（絶対MIDIノート値で計算） ──────────────────────────
function getEnharmonicPair(midi) {
  const noteInOctave = midi % 12;
  const octave = Math.floor(midi / 12);
  const mapping = ENHARMONIC_MAP[noteInOctave];
  
  if (!mapping) return null;
  
  // 相対値から絶対MIDIノート値に変換
  // note1: 下の白鍵（-1）
  // note2: 上の白鍵（+1）
  return {
    note1: { ...mapping.note1, midi: midi - 1 },
    note2: { ...mapping.note2, midi: midi + 1 }
  };
}

// ── オートコリレーション（コンポーネント外に定義） ────────────────────────────
// RMS が閾値未満（無音）のときは null を返す
function autoCorrelate(buffer, sampleRate) {
  const SIZE = buffer.length;

  // 無音チェック
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return null;

  // ゼロ交差付近をトリミングして精度向上
  let r1 = 0;
  let r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  }

  const buf = buffer.slice(r1, r2);
  const len = buf.length;
  if (len < 2) return null;

  // 自己相関
  const c = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    for (let j = 0; j < len - i; j++) {
      c[i] += buf[j] * buf[j + i];
    }
  }

  // 最初の極小を探す
  let d = 0;
  while (d < len - 1 && c[d] > c[d + 1]) d++;

  // 極小以降の最大値（基本周期）を探す
  let maxval = -Infinity;
  let maxpos = -1;
  for (let i = d; i < len; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }

  if (maxpos < 1) return null;

  // 放物線補間で精度向上
  let T0 = maxpos;
  if (maxpos > 0 && maxpos < len - 1) {
    const x1 = c[maxpos - 1];
    const x2 = c[maxpos];
    const x3 = c[maxpos + 1];
    T0 = maxpos + 0.5 * (x1 - x3) / (x1 - 2 * x2 + x3);
  }

  return sampleRate / T0;
}

// ── MIDI ノート番号から音階に変換 ──────────────────────────────────────────────
function midiToNote(midiNote) {
  if (midiNote === null || midiNote === undefined) return '--';

  const octave = Math.floor(midiNote / 12) - 1;
  const noteIndex = midiNote % 12;

  const noteNames = [
    'ド', 'ド♯/レ♭', 'レ', 'レ♯/ミ♭', 'ミ', 'ファ',
    'ファ♯/ソ♭', 'ソ', 'ソ♯/ラ♭', 'ラ', 'ラ♯/シ♭', 'シ'
  ];
  const noteName = noteNames[noteIndex];

  return `${noteName}${octave}`;
}

// ── 周波数を音階に変換 ────────────────────────────────────────────────────────
// 基準周波数: A4 = 440 Hz, MIDI ノート 69
function freqToNote(freq) {
  if (!freq) return '--';

  const A4 = 440;
  const midiNote = Math.round(12 * Math.log2(freq / A4) + 69);

  return midiToNote(midiNote);
}

// ── MIDI ノート番号から周波数を計算 ───────────────────────────────────────────────
function midiToFreq(midiNote) {
  if (midiNote === null || midiNote === undefined) return null;
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

// ── マイク周波数とセント差分を計算 ──────────────────────────────────────────────────
function getCentDiff(micFreq, targetFreq) {
  if (!micFreq || !targetFreq) return null;
  return 1200 * Math.log2(micFreq / targetFreq);
}

// ── 現在時刻に対応する目標 MIDI ノートを取得 ─────────────────────────────
function getTargetMidi(notes, currentTime) {
  if (!notes) return null;
  const note = notes.find(n => currentTime >= n.start && currentTime < n.end);
  return note ? note.midi : null;
}

// ── マイク周波数と目標 MIDI から5段階評価を返す ──────────────────────────
function getPitchRating(micFreq, targetMidi, tolerance) {
  if (!micFreq || targetMidi === null) return null;
  const targetFreq = 440 * Math.pow(2, (targetMidi - 69) / 12);
  const diffSemitones = 12 * Math.log2(micFreq / targetFreq);

  // 難易度に応じた許容幅で判定
  if (diffSemitones > tolerance + 1.0) return { label: '高い',     color: '#e05050' };
  if (diffSemitones > tolerance)       return { label: '少し高い', color: '#e09050' };
  if (diffSemitones > -tolerance)      return { label: 'いいね！', color: '#3ca83c' };
  if (diffSemitones > -tolerance - 1.0) return { label: '少し低い', color: '#5090e0' };
                                         return { label: '低い',     color: '#a050e0' };
}

// ── diffSemitones から directly 5段階評価を返す ───────────────────────────
function getRatingFromDiffSemitones(diffSemitones, tolerance) {
  if (diffSemitones === null || diffSemitones === undefined) return null;

  if (diffSemitones > tolerance + 1.0) return { label: '高い',     color: '#e05050' };
  if (diffSemitones > tolerance)       return { label: '少し高い', color: '#e09050' };
  if (diffSemitones > -tolerance)      return { label: 'いいね！', color: '#3ca83c' };
  if (diffSemitones > -tolerance - 1.0) return { label: '少し低い', color: '#5090e0' };
                                         return { label: '低い',     color: '#a050e0' };
}

// ── NoteCard SVG コンポーネント（改善版） ────────────────────────────────────
function NoteCard({ midi, rating }) {
  const { svgWidth, svgHeight, staffLineY, noteCircleRadius, stemWidth } = STAFF_CONFIG;
  const noteColor = rating?.color || '#999';

  // 休符判定
  if (midi === null) {
    return (
      <svg
        width={svgWidth}
        height={svgHeight}
        style={{
          background: 'white',
          border: '2px solid #ddd',
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          display: 'block',
          margin: '0 auto',
        }}
      >
        <rect width={svgWidth} height={svgHeight} fill="white" />
        <text
          x={svgWidth / 2}
          y={svgHeight / 2}
          textAnchor="middle"
          dy="0.3em"
          fontSize={20}
          fontWeight="bold"
          fill="#999"
        >
          休符
        </text>
      </svg>
    );
  }

  const noteInOctave = midi % 12;
  const isBlackKey = IS_BLACK_KEY(noteInOctave);

  // 黒鍵の場合：異名同音2つを表示
  if (isBlackKey) {
    const enharmonic = getEnharmonicPair(midi);
    if (!enharmonic) {
      return (
        <svg width={svgWidth} height={svgHeight} style={{ background: 'white', border: '2px solid #ddd', borderRadius: 8 }}>
          <rect width={svgWidth} height={svgHeight} fill="white" />
        </svg>
      );
    }

    // 左側音符（note1）
    const y1 = getMidiY(enharmonic.note1.midi);
    const stemDown1 = isStemDown(enharmonic.note1.midi);
    const stemX1 = getStemX(55, enharmonic.note1.midi);
    const stem1 = getStemYRange(enharmonic.note1.midi, y1 || 0);

    // 右側音符（note2）
    const y2 = getMidiY(enharmonic.note2.midi);
    const stemDown2 = isStemDown(enharmonic.note2.midi);
    const stemX2 = getStemX(105, enharmonic.note2.midi);
    const stem2 = getStemYRange(enharmonic.note2.midi, y2 || 0);

    return (
      <svg
        width={svgWidth}
        height={svgHeight}
        style={{
          background: 'white',
          border: '2px solid #ddd',
          borderRadius: 8,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
          display: 'block',
          margin: '0 auto',
        }}
      >
        <rect width={svgWidth} height={svgHeight} fill="white" />

        {/* 五線 */}
        {staffLineY.map((lineY, i) => (
          <line key={`line-${i}`} x1={15} y1={lineY} x2={145} y2={lineY} stroke="#ccc" strokeWidth="1" />
        ))}

        {/* 左側音符 */}
        {y1 !== null && (
          <g>
            <circle cx={55} cy={y1} r={noteCircleRadius} fill={noteColor} />
            <line x1={stemX1} y1={stem1.y1} x2={stemX1} y2={stem1.y2} stroke={noteColor} strokeWidth={stemWidth} />
          </g>
        )}

        {/* 右側音符 */}
        {y2 !== null && (
          <g>
            <circle cx={105} cy={y2} r={noteCircleRadius} fill={noteColor} />
            <line x1={stemX2} y1={stem2.y1} x2={stemX2} y2={stem2.y2} stroke={noteColor} strokeWidth={stemWidth} />
          </g>
        )}

        {/* 音名ラベル：左 */}
        <text x={39} y={135} fontSize={11} fontWeight="bold" fill="#999" textAnchor="end">
          {enharmonic.note1.accidental}
        </text>
        <text x={55} y={145} fontSize={12} fontWeight="bold" fill="#333" textAnchor="middle">
          {enharmonic.note1.name}
        </text>

        {/* 音名ラベル：右 */}
        <text x={89} y={135} fontSize={11} fontWeight="bold" fill="#999" textAnchor="end">
          {enharmonic.note2.accidental}
        </text>
        <text x={105} y={145} fontSize={12} fontWeight="bold" fill="#333" textAnchor="middle">
          {enharmonic.note2.name}
        </text>

        {/* 評価ラベル */}
        {rating && (
          <text x={svgWidth / 2} y={160} textAnchor="middle" fontSize={12} fontWeight="bold" fill={noteColor}>
            {rating.label}
          </text>
        )}
      </svg>
    );
  }

  // 白鍵の場合：1つの音符を表示
  const y = getMidiY(midi);
  if (y === null) {
    return (
      <svg width={svgWidth} height={svgHeight} style={{ background: 'white', border: '2px solid #ddd', borderRadius: 8 }}>
        <rect width={svgWidth} height={svgHeight} fill="white" />
      </svg>
    );
  }

  const stemDown = isStemDown(midi);
  const stemX = getStemX(80, midi);
  const { y1, y2 } = getStemYRange(midi, y);
  const noteName = midiToNote(midi);

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      style={{
        background: 'white',
        border: '2px solid #ddd',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
        display: 'block',
        margin: '0 auto',
      }}
    >
      <rect width={svgWidth} height={svgHeight} fill="white" />

      {/* 五線 */}
      {staffLineY.map((lineY, i) => (
        <line key={`line-${i}`} x1={15} y1={lineY} x2={145} y2={lineY} stroke="#ccc" strokeWidth="1" />
      ))}

      {/* 音符 */}
      <circle cx={80} cy={y} r={noteCircleRadius} fill={noteColor} />
      <line x1={stemX} y1={y1} x2={stemX} y2={y2} stroke={noteColor} strokeWidth={stemWidth} />

      {/* 音名テキスト */}
      <text x={svgWidth / 2} y={135} textAnchor="middle" fontSize={16} fontWeight="bold" fill="#333">
        {noteName}
      </text>

      {/* 評価ラベル */}
      {rating && (
        <text x={svgWidth / 2} y={160} textAnchor="middle" fontSize={12} fontWeight="bold" fill={noteColor}>
          {rating.label}
        </text>
      )}
    </svg>
  );
}

// ── メインコンポーネント ──────────────────────────────────────────────────────
export default function App() {

  // ── state ─────────────────────────────────────────────────────────────────
  const [isPlaying,      setIsPlaying]      = useState(false);
  const [isReady,        setIsReady]        = useState(false);
  const [loadError,      setLoadError]      = useState(null);
  const [currentTime,    setCurrentTime]    = useState(0);
  const [duration,       setDuration]       = useState(0);
  const [volumes,        setVolumes]        = useState(INITIAL_VOLUMES);
  const [songs,          setSongs]          = useState([]);
  const [selectedSongId, setSelectedSongId] = useState(null);
  const [micFreq,        setMicFreq]        = useState(null);
  const [selectedPart,   setSelectedPart]   = useState('none');
  const [difficulty,     setDifficulty]     = useState('normal');
  const [debugMode,      setDebugMode]      = useState(false);
  const [pitchHistory,   setPitchHistory]   = useState([]);
  const [noteResults,    setNoteResults]    = useState([]);

  // ── ref ───────────────────────────────────────────────────────────────────
  const playersRef                  = useRef({});
  const rafRef                      = useRef(null);
  const isDraggingRef               = useRef(false);
  const analyserRef                 = useRef(null);
  const dataArrayRef                = useRef(null);
  const notesRef                    = useRef({});
  const pitchHistoryRef             = useRef([]);
  const currentTargetMidiRef        = useRef(null);
  const currentNoteDiffValuesRef    = useRef([]);
  const currentNoteStartTimeRef     = useRef(null);
  const currentNoteEndTimeRef       = useRef(null);
  const difficultyRef               = useRef(difficulty);

  // difficulty state の更新を ref に反映
  useEffect(() => {
    difficultyRef.current = difficulty;
  }, [difficulty]);

  // ── songs.json 取得（初回マウント時） ────────────────────────────────────
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}songs/songs.json`)
      .then(res => res.json())
      .then(data => {
        setSongs(data);
        if (data.length > 0) {
          setSelectedSongId(data[0].id);
        }
      })
      .catch(err => setLoadError(String(err)));
  }, []);

  // ── 曲変更時に Player を再ロード ─────────────────────────────────────────
  useEffect(() => {
    if (!selectedSongId || songs.length === 0) return;

    setIsReady(false);
    setCurrentTime(0);
    setNoteResults([]);
    Tone.Transport.stop();

    Object.values(playersRef.current).forEach(p => p.dispose());

    const song = songs.find(s => s.id === selectedSongId);
    if (!song) return;

    const folder = song.folder;
    const players = {};

    // ★ 同期設計の核心:
    //   .sync()   → Transport をマスタークロックとして登録
    //   .start(0) → Transport 時刻 0 に再生開始をスケジュール
    TRACKS.forEach(({ id }) => {
      const url = `${import.meta.env.BASE_URL}songs/${folder}/${id}.mp3`;
      const player = new Tone.Player(url).toDestination();
      player.sync().start(0);
      players[id] = player;
    });

    playersRef.current = players;

    // MIDI JSON をロード（Soprano / Alto）
    Promise.all([
      fetch(`${import.meta.env.BASE_URL}songs/${folder}/Soprano.json`).then(r => r.json()),
      fetch(`${import.meta.env.BASE_URL}songs/${folder}/Alto.json`).then(r => r.json()),
    ])
      .then(([soprano, alto]) => {
        notesRef.current = {
          soprano: soprano.notes,
          alto: alto.notes,
        };
      })
      .catch(() => {
        notesRef.current = {};
      });

    Tone.loaded()
      .then(() => {
        const maxDur = Math.max(
          ...Object.values(players).map(p => p.buffer.duration)
        );
        setDuration(maxDur);
        setIsReady(true);
      })
      .catch(err => setLoadError(String(err)));

    return () => {
      Tone.Transport.stop();
      Tone.Transport.cancel();
      Object.values(players).forEach(p => p.dispose());
    };
  }, [selectedSongId, songs]);

  // ── RAF ループ: 再生位置 + マイク周波数を更新 + ノート単位評価 ──────────
  useEffect(() => {
    const tick = () => {
      let freq = null;

      // 再生位置を Transport から取得（ドラッグ中は上書きしない）
      if (!isDraggingRef.current) {
        setCurrentTime(Tone.Transport.seconds);
      }

      // マイク周波数検出
      const analyser = analyserRef.current;
      const dataArray = dataArrayRef.current;
      if (analyser && dataArray) {
        analyser.getFloatTimeDomainData(dataArray);
        freq = autoCorrelate(dataArray, analyser.context.sampleRate);
        if (freq !== null) {
          setMicFreq(freq);

          // ピッチ履歴に記録（過去 5 秒分）
          if (selectedPart !== 'none') {
            const notes = notesRef.current[selectedPart];
            const targetMidi = getTargetMidi(notes, Tone.Transport.seconds);
            if (targetMidi !== null) {
              const targetFreq = midiToFreq(targetMidi);
              const diffSemitones = 12 * Math.log2(freq / targetFreq);
              const newHistory = [...pitchHistoryRef.current, { time: Tone.Transport.seconds, diffSemitones }];
              // 過去 5 秒分のみ保持（約 300 フレーム）
              if (newHistory.length > 300) newHistory.shift();
              pitchHistoryRef.current = newHistory;
              setPitchHistory(newHistory);
            }
          }
        }
      }

      // ── ノート単位評価ロジック ──────────────────────────────────────────
      if (selectedPart !== 'none') {
        const notes = notesRef.current[selectedPart];
        const currentTargetMidi = getTargetMidi(notes, Tone.Transport.seconds);
        const currentDiffObj = DIFFICULTIES.find(d => d.id === difficultyRef.current) || DIFFICULTIES[1];

        // 現在のノート終了時刻を取得
        let noteEndTime = null;
        if (currentTargetMidi !== null) {
          const currentNote = notes?.find(n => Tone.Transport.seconds >= n.start && Tone.Transport.seconds < n.end);
          if (currentNote) {
            noteEndTime = currentNote.end;
          }
        }

        // targetMidi が変化したか、またはノートが終了したか確認
        const targetChanged = currentTargetMidi !== currentTargetMidiRef.current;
        const noteEnded = currentTargetMidiRef.current !== null &&
                          currentNoteEndTimeRef.current !== null &&
                          Tone.Transport.seconds >= currentNoteEndTimeRef.current;

        if (targetChanged || noteEnded) {
          // 直前ノートの確定処理
          if (currentTargetMidiRef.current !== null && currentNoteDiffValuesRef.current.length > 0) {
            const avgDiff = calculateTrimmedMean(currentNoteDiffValuesRef.current);
            const rating = getRatingFromDiffSemitones(avgDiff, currentDiffObj.tolerance);
            const noteDuration = currentNoteEndTimeRef.current - currentNoteStartTimeRef.current;

            // ノート長が0.15秒以上で、有効な評価がある場合のみ保存
            if (noteDuration >= 0.15 && rating) {
              const newNoteResult = {
                midi: currentTargetMidiRef.current,
                noteName: midiToNote(currentTargetMidiRef.current),
                avgDiff: avgDiff,
                rating: rating,
              };
              setNoteResults(prev => {
                const updated = [...prev, newNoteResult];
                if (updated.length > 20) updated.shift();
                return updated;
              });
            }
          }

          // 新ノートの開始
          if (currentTargetMidi !== null) {
            currentTargetMidiRef.current = currentTargetMidi;
            currentNoteDiffValuesRef.current = [];
            currentNoteStartTimeRef.current = Tone.Transport.seconds;
            currentNoteEndTimeRef.current = noteEndTime;
          } else {
            currentTargetMidiRef.current = null;
            currentNoteDiffValuesRef.current = [];
            currentNoteStartTimeRef.current = null;
            currentNoteEndTimeRef.current = null;
          }
        }

        // 現在の diff を収集
        if (freq !== null && currentTargetMidi !== null) {
          const targetFreq = midiToFreq(currentTargetMidi);
          const diff = 12 * Math.log2(freq / targetFreq);
          currentNoteDiffValuesRef.current.push(diff);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [selectedPart, difficulty]);

  // ── AudioContext 起動 ─────────────────────────────────────────────────────
  // Tone.start() = AudioContext.resume() のラッパー。既に running なら即返す。
  const ensureAudioContext = useCallback(async () => {
    if (Tone.getContext().state !== 'running') {
      await Tone.start();
    }
  }, []);

  // ── マイク初期化 ──────────────────────────────────────────────────────────
  // Tone.getContext().rawContext を使用して Web Audio API に直接アクセス
  const initMic = useCallback(async () => {
    if (analyserRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rawCtx = Tone.getContext().rawContext;
      const source = rawCtx.createMediaStreamSource(stream);
      const analyser = rawCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataArrayRef.current = new Float32Array(analyser.fftSize);
    } catch (err) {
      console.warn('マイク初期化失敗:', err);
    }
  }, []);

  // ── 再生 / 一時停止 ───────────────────────────────────────────────────────
  const handlePlayPause = useCallback(async () => {
    await ensureAudioContext();
    await initMic();

    if (Tone.Transport.state === 'started') {
      Tone.Transport.pause();
      setIsPlaying(false);
    } else {
      Tone.Transport.start();
      setIsPlaying(true);
    }
  }, [ensureAudioContext, initMic]);

  // ── 停止（先頭リセット） ──────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    Tone.Transport.stop();
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  // ── シーク ────────────────────────────────────────────────────────────────
  // player.seek() 禁止のため Transport.seconds のみ操作する
  // パターン: pause → seconds 変更 → start（再生中だった場合）
  const handleSeekChange = useCallback((e) => {
    const seekTo = Number(e.target.value);
    const wasPlaying = Tone.Transport.state === 'started';

    if (wasPlaying) Tone.Transport.pause();
    Tone.Transport.seconds = seekTo;
    setCurrentTime(seekTo);
    if (wasPlaying) Tone.Transport.start();
  }, []);

  const handleSeekPointerDown = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const handleSeekPointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  // ── 音量変更 ──────────────────────────────────────────────────────────────
  const handleVolumeChange = useCallback((id, val) => {
    setVolumes(prev => ({ ...prev, [id]: val }));
    if (playersRef.current[id]) {
      playersRef.current[id].volume.value = val;
    }
  }, []);

  // ── 難易度変更 ────────────────────────────────────────────────────────────
  const handleDifficultyChange = useCallback((difficultyId) => {
    setDifficulty(difficultyId);
  }, []);

  // ── 現在の難易度オブジェクトを取得 ────────────────────────────────────────
  const currentDiffObj = DIFFICULTIES.find(d => d.id === difficulty) || DIFFICULTIES[1];

  // ── スタイル定数 ──────────────────────────────────────────────────────────
  const section = { marginBottom: 24 };
  const labelSt = {
    display: 'block',
    fontSize: 14,
    marginBottom: 8,
    fontWeight: 'bold',
    color: '#333',
  };

  // ── レンダリング ──────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 24, maxWidth: 480, margin: '0 auto', fontFamily: 'sans-serif', fontSize: 16 }}>
      <h1 style={{ fontSize: 20, marginBottom: 28, color: '#222' }}>音取りくん</h1>

      {loadError && (
        <p style={{ color: 'red', background: '#fff0f0', padding: 12, borderRadius: 6 }}>
          読み込みエラー: {loadError}
        </p>
      )}

      {!isReady && !loadError && (
        <p style={{ color: '#888' }}>音源を読み込み中...</p>
      )}

      {isReady && (
        <>
          {/* 曲選択 */}
          <div style={section}>
            <span style={labelSt}>曲選択</span>
            <select
              value={selectedSongId}
              onChange={e => setSelectedSongId(e.target.value)}
              style={{ width: '100%', padding: '8px', fontSize: 16, borderRadius: 4, border: '1px solid #bbb' }}
            >
              {songs.map(song => (
                <option key={song.id} value={song.id}>{song.title}</option>
              ))}
            </select>
          </div>

          {/* 判定パート選択 */}
          <div style={section}>
            <span style={labelSt}>判定パート</span>
            <select
              value={selectedPart}
              onChange={e => setSelectedPart(e.target.value)}
              style={{ width: '100%', padding: '8px', fontSize: 16, borderRadius: 4, border: '1px solid #bbb' }}
            >
              <option value="none">判定しない（ピッチ非表示）</option>
              <option value="soprano">ソプラノ</option>
              <option value="alto">アルト</option>
            </select>
          </div>

          {/* 難易度選択（星マークボタン） */}
          {selectedPart !== 'none' && (
            <div style={section}>
              <span style={labelSt}>難易度</span>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                {DIFFICULTIES.map(d => (
                  <button
                    key={d.id}
                    onClick={() => handleDifficultyChange(d.id)}
                    style={{
                      padding: '12px 20px',
                      fontSize: 18,
                      background: difficulty === d.id ? '#3ca83c' : '#eee',
                      color: difficulty === d.id ? 'white' : '#333',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontWeight: difficulty === d.id ? 'bold' : 'normal',
                      transition: 'all 0.2s',
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 再生 / 停止ボタン */}
          <div style={section}>
            <button
              onClick={handlePlayPause}
              style={{ marginRight: 8, padding: '12px 28px', fontSize: 16 }}
            >
              {isPlaying ? '⏸ 一時停止' : '▶ 再生'}
            </button>
            <button
              onClick={handleStop}
              style={{ padding: '12px 28px', fontSize: 16 }}
            >
              ⏹ 停止
            </button>
          </div>

          {/* 音符カード表示 */}
          {selectedPart !== 'none' && (
            <>
              {(() => {
                const notes = notesRef.current[selectedPart];
                const targetMidi = getTargetMidi(notes, currentTime);
                const rating = getPitchRating(micFreq, targetMidi, currentDiffObj.tolerance);

                return (
                  <div style={section}>
                    <NoteCard midi={targetMidi} rating={rating} />
                  </div>
                );
              })()}

              {/* デバッグモード切り替えボタン */}
              <div style={{ ...section, display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setDebugMode(!debugMode)}
                  style={{
                    padding: '8px 16px',
                    fontSize: 13,
                    background: debugMode ? '#3ca83c' : '#ccc',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                >
                  {debugMode ? '🔍 デバッグ: ON' : '⚙️ デバッグ: OFF'}
                </button>
              </div>

              {/* デバッグパネル */}
              {debugMode && (
                <div style={{
                  ...section,
                  fontSize: 12,
                  color: '#333',
                  background: '#f0f0f0',
                  padding: 12,
                  borderRadius: 6,
                  fontFamily: 'monospace',
                  lineHeight: 1.8,
                }}>
                  {(() => {
                    const notes = notesRef.current[selectedPart];
                    const targetMidi = getTargetMidi(notes, currentTime);
                    const targetFreq = midiToFreq(targetMidi);
                    const centDiff = getCentDiff(micFreq, targetFreq);
                    const position = getMidiPosition(targetMidi);

                    return (
                      <>
                        <div>再生時刻: <strong>{currentTime.toFixed(2)}</strong> 秒</div>
                        <div>目標 MIDI: <strong>{targetMidi ?? '---'}</strong> {targetMidi !== null ? `(${midiToNote(targetMidi)})` : ''}</div>
                        <div>目標周波数: <strong>{targetFreq ? targetFreq.toFixed(2) : '---'}</strong> Hz</div>
                        <div>マイク周波数: <strong>{micFreq ? micFreq.toFixed(2) : '---'}</strong> Hz</div>
                        <div>セント差分: <strong>{centDiff ? centDiff.toFixed(1) : '---'}</strong> ¢</div>
                        <div>五線上の position: <strong>{position ?? '---'}</strong></div>
                        <div>難易度: <strong>{currentDiffObj.label}</strong> (許容幅: ±{currentDiffObj.tolerance} semitone)</div>
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #ccc' }}>
                          ノート単位評価:
                        </div>
                        <div>現在のノート diff 数: <strong>{currentNoteDiffValuesRef.current.length}</strong></div>
                        {currentNoteDiffValuesRef.current.length > 0 && (
                          <div>現在のノート中央80%平均: <strong>{calculateTrimmedMean(currentNoteDiffValuesRef.current).toFixed(2)}</strong></div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* ピッチ履歴表示（ゼロ中心の縦方向ベクトル） */}
              {pitchHistory.length > 0 && (
                <div style={{ ...section, background: '#f9f9f9', padding: 12, borderRadius: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 16, color: '#333' }}>
                    過去のピッチ
                  </div>

                  {/* ゼロ中心の縦方向ベクトル表示 */}
                  <div style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'stretch',
                    justifyContent: 'space-between',
                    gap: 3,
                    height: 120,
                    background: 'white',
                    padding: '8px',
                    borderRadius: 4,
                    border: '1px solid #ddd',
                  }}>
                    {/* いいねゾーン帯（難易度に応じた幅） */}
                    {(() => {
                      const maxRange = 3.0;
                      const zoneHeightPercent = (currentDiffObj.tolerance / maxRange) * 100;
                      return (
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: `${50 - zoneHeightPercent / 2}%`,
                            height: `${zoneHeightPercent}%`,
                            background: 'rgba(60, 168, 60, 0.1)',
                            borderRadius: 2,
                            pointerEvents: 'none',
                          }}
                        />
                      );
                    })()}

                    {/* 基準線（中央） */}
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: '50%',
                        height: '2px',
                        background: '#ddd',
                        pointerEvents: 'none',
                      }}
                    />

                    {/* バー群 */}
                    {pitchHistory.slice(-30).map((p, i) => {
                      const maxRange = 3.0;
                      const normalizedDiff = p.diffSemitones / maxRange;
                      const barHeightPercent = Math.abs(normalizedDiff) * 100;
                      const isHigher = p.diffSemitones > 0;  // 目標より高い

                      let barColor = '#ccc';
                      if (p.diffSemitones > currentDiffObj.tolerance + 1.0) barColor = '#e05050';
                      else if (p.diffSemitones > currentDiffObj.tolerance) barColor = '#e09050';
                      else if (p.diffSemitones > -currentDiffObj.tolerance) barColor = '#3ca83c';
                      else if (p.diffSemitones > -currentDiffObj.tolerance - 1.0) barColor = '#5090e0';
                      else barColor = '#a050e0';

                      return (
                        <div
                          key={i}
                          style={{
                            flex: 1,
                            position: 'relative',
                            height: '100%',
                          }}
                        >
                          {/* バー（中央50%を基準に上下に伸びる）
                              高い音 → 上に伸びる（top値が小さい）
                              低い音 → 下に伸びる（top値が大きい）
                          */}
                          <div
                            style={{
                              position: 'absolute',
                              left: 0,
                              right: 0,
                              top: isHigher ? `${50 - barHeightPercent}%` : '50%',
                              height: `${barHeightPercent}%`,
                              background: barColor,
                              borderRadius: 2,
                              opacity: 0.85,
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* 凡例 */}
                  <div style={{ fontSize: 12, color: '#666', marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ display: 'inline-block', width: 12, height: 12, background: '#3ca83c', borderRadius: 2 }} />
                      いいね！
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ display: 'inline-block', width: 12, height: 12, background: '#e05050', borderRadius: 2 }} />
                      高い
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ display: 'inline-block', width: 12, height: 12, background: '#5090e0', borderRadius: 2 }} />
                      低い
                    </span>
                  </div>
                </div>
              )}

              {/* ノート単位評価 */}
              {noteResults.length > 0 && (
                <div style={{ ...section, background: '#f9f9f9', padding: 12, borderRadius: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 12, color: '#333' }}>
                    音符ごとの評価
                  </div>

                  <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    justifyContent: 'flex-start',
                  }}>
                    {noteResults.map((noteResult, i) => {
                      const ratingEmoji = noteResult.rating.label === 'いいね！' ? '✅' :
                                         noteResult.rating.label.includes('少し') ? '🟡' :
                                         noteResult.rating.label === '高い' || noteResult.rating.label === '低い' ? '⚠️' : '❓';

                      return (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minWidth: 60,
                            padding: '8px 12px',
                            background: 'white',
                            border: `2px solid ${noteResult.rating.color}`,
                            borderRadius: 6,
                            textAlign: 'center',
                          }}
                        >
                          <div style={{ fontSize: 14, fontWeight: 'bold', color: '#333' }}>
                            {noteResult.noteName}
                          </div>
                          <div style={{ fontSize: 16, marginTop: 2 }}>
                            {ratingEmoji}
                          </div>
                          <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
                            {noteResult.rating.label}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {/* 再生位置スライダー */}
          <div style={section}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6, color: '#555' }}>
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.5}
              value={Math.min(currentTime, duration)}
              onChange={handleSeekChange}
              onPointerDown={handleSeekPointerDown}
              onPointerUp={handleSeekPointerUp}
            />
          </div>

          {/* トラック音量スライダー */}
          {TRACKS.map(t => (
            <div key={t.id} style={section}>
              <span style={labelSt}>
                {t.label}: {volumes[t.id] === -40 ? '最小' : `${volumes[t.id]} dB`}
              </span>
              <input
                type="range"
                min={-40}
                max={6}
                step={1}
                value={volumes[t.id]}
                onChange={e => handleVolumeChange(t.id, Number(e.target.value))}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
