import { useState } from "preact/hooks";

type XPWindowProps = {
  title: string;
  children: preact.ComponentChildren;
  onClose: () => void;
};

export default function Window({ title, children, onClose }: XPWindowProps) {
  const [pos, setPos] = useState({ x: 180, y: 100 });
  const [size, setSize] = useState({ w: 360, h: 240 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  function startDrag(e: MouseEvent) {
    setDragging(true);
    setOffset({ x: e.clientX - pos.x, y: e.clientY - pos.y });
  }

  function startResize(e: MouseEvent) {
    e.stopPropagation();
    setResizing(true);
  }

  function onMouseMove(e: MouseEvent) {
    if (dragging) {
      setPos({
        x: e.clientX - offset.x,
        y: e.clientY - offset.y,
      });
    }

    if (resizing) {
      setSize({
        w: Math.max(220, e.clientX - pos.x),
        h: Math.max(140, e.clientY - pos.y),
      });
    }
  }

  function stopActions() {
    setDragging(false);
    setResizing(false);
  }

  return (
    <div
      class="xp-window"
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.w}px`,
        height: `${size.h}px`,
      }}
      onMouseMove={onMouseMove}
      onMouseUp={stopActions}
      onMouseLeave={stopActions}
    >
      <div class="xp-titlebar" onMouseDown={startDrag}>
        <span>{title}</span>
        <button class="xp-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div class="xp-content">{children}</div>

      <div class="resize-handle" onMouseDown={startResize} />
    </div>
  );
}