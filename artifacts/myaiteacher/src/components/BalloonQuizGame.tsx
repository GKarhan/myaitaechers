import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import "./balloon-quiz-game.css";

const LABELS = ["Ա", "Բ", "Գ", "Դ", "Ե", "Զ"];
const COLORS = ["#a78bfa", "#38bdf8", "#fbbf24", "#f472b6", "#fb923c", "#2dd4bf"];

type Props = {
  question: string;
  options: string[];
  selectedIndex?: number;
  correctIndex: number | null;
  answered: boolean;
  disabled: boolean;
  onChoose: (index: number) => Promise<void>;
};

/** Presentation only: the existing feedback endpoint owns every answer/score. */
export function BalloonQuizGame({ question, options, selectedIndex, correctIndex, answered, disabled, onChoose }: Props) {
  const arena = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const [aim, setAim] = useState(0);
  const [shot, setShot] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current !== null) clearTimeout(timer.current); };
  }, []);

  function fire(index: number, event: MouseEvent<HTMLButtonElement>) {
    if (busy.current || disabled || answered || !arena.current || !launcher.current) return;
    busy.current = true;
    const bounds = arena.current.getBoundingClientRect();
    const target = event.currentTarget.getBoundingClientRect();
    const base = launcher.current.getBoundingClientRect();
    const origin = { x: base.left + base.width / 2 - bounds.left, y: base.top + 55 - bounds.top };
    const end = { x: target.left + target.width / 2 - bounds.left, y: target.top + target.height / 2 - bounds.top };
    const angle = Math.atan2(end.x - origin.x, origin.y - end.y);
    const start = { x: origin.x + Math.sin(angle) * 44, y: origin.y - Math.cos(angle) * 44 };
    setAim(angle * 180 / Math.PI);
    setShot({ ...start, dx: end.x - start.x, dy: end.y - start.y });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!alive.current) return;
      void onChoose(index).finally(() => {
        busy.current = false;
        if (alive.current) setShot(null);
      });
    }, reducedMotion ? 0 : 340);
  }

  return <div className="balloon-game">
    <p className="text-xs text-white/60 mb-4">Սեղմիր ճիշտ պատասխանի փուչիկին։</p>
    <div ref={arena} className="balloon-game-arena">
      <div className="balloon-game-options" role="group" aria-label={question}>
        {options.map((option, index) => {
          const correct = answered && correctIndex === index;
          const wrong = answered && selectedIndex === index && !correct;
          const outcome = correct ? "correct" : wrong ? "wrong" : answered ? "muted" : "idle";
          return <div key={index} className="balloon-game-target">
            <button type="button" disabled={disabled || answered || shot !== null}
              onClick={event => fire(index, event)}
              className={`balloon-game-balloon balloon-game-${outcome}`}
              style={{ "--balloon-color": COLORS[index % COLORS.length] } as CSSProperties}
              aria-label={`${LABELS[index] ?? index + 1}. ${option}${correct ? " · Ճիշտ է" : wrong ? " · Սխալ է" : ""}`}>
              <span className="balloon-game-letter">{correct ? "✓" : wrong ? "✕" : LABELS[index] ?? index + 1}</span>
              <span className="relative z-10">{option}</span>
            </button>
            <span className="balloon-game-string" aria-hidden="true" />
          </div>;
        })}
      </div>
      {shot && <span className="balloon-game-shot" aria-hidden="true" style={{ left: shot.x, top: shot.y,
        "--shot-dx": `${shot.dx}px`, "--shot-dy": `${shot.dy}px` } as CSSProperties} />}
      <div ref={launcher} className="balloon-game-launcher" aria-hidden="true">
        <svg viewBox="0 0 132 88" width="132" height="88">
          <ellipse cx="66" cy="80" rx="61" ry="6" fill="#38bdf8" opacity=".12" />
          <g style={{ transform: `rotate(${aim}deg)`, transformOrigin: "66px 55px", transition: "transform 160ms ease-out" }}>
            <rect x="59" y="8" width="14" height="46" rx="6" fill="#67e8f9" />
            <rect x="56" y="7" width="20" height="10" rx="4" fill="#cffafe" />
          </g>
          <path d="M37 63 Q37 36 66 36 Q95 36 95 63" fill="#6366f1" stroke="#a5b4fc" strokeWidth="2" />
          <rect x="18" y="59" width="96" height="20" rx="10" fill="#1e293b" stroke="#64748b" strokeWidth="2" />
          {[33,55,77,99].map(x=><circle key={x} cx={x} cy="69" r="5" fill="#818cf8" />)}
          <circle cx="66" cy="54" r="6" fill="#cffafe" />
        </svg>
      </div>
    </div>
    <div className="balloon-game-question">
      <h1 className="text-base sm:text-lg font-semibold leading-relaxed">{question}</h1>
    </div>
  </div>;
}
