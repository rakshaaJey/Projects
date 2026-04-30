import { useEffect, useState } from "preact/hooks";

type DraggableIconProps = {
  id: string;
  img: string;
  label: string;
  x: number;
  y: number;
  onMove: (id: string, x: number, y: number) => void;
  onClick?: () => void;
};

export function DraggableIcon({ id, img, label, x, y, onMove, onClick }: DraggableIconProps) {
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [tempPos, setTempPos] = useState({ x, y });
  const [isClick, setIsClick] = useState(false);

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();

    setDragging(true);
    setIsClick(true);
    setTempPos({ x, y });

    setOffset({
      x: e.clientX - x,
      y: e.clientY - y,
    });
  }

  useEffect(() => {
    if (!dragging) return;

    function handleMouseMove(e: MouseEvent) {
      const nextX = e.clientX - offset.x;
      const nextY = e.clientY - offset.y;
      if (Math.abs(nextX - tempPos.x) > 4 || Math.abs(nextY - tempPos.y) > 4) {
        setIsClick(false);
      }
      setTempPos({
        x: nextX,
        y: nextY,
      });
    }

    function handleMouseUp() {
      setDragging(false);
      if (isClick) {
        onClick?.();
      } else {
        onMove(id, tempPos.x, tempPos.y);
      }
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, offset.x, offset.y, tempPos.x, tempPos.y]);

  return (
    <div
      class="desktop-icon"
      style={{
        left: `${dragging ? tempPos.x : x}px`,
        top: `${dragging ? tempPos.y : y}px`,
      }}
      onMouseDown={handleMouseDown}
    >
      <img src={img} />
      <span>{label}</span>
    </div>
  );
}