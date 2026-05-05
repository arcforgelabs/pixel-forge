import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  SVG_LOGO_CENTER,
  SVG_LOGO_VIEWBOX_SIZE,
  moveSvgObject,
  snapSvgObjectToGrid,
  svgObjectBounds,
  type SvgLogoObject,
} from "./svg-logo";

interface Props {
  objects: SvgLogoObject[];
  renderSize: number;
  background: string;
  previewSurface: "configured" | "black" | "white";
  previewShowBackground: boolean;
  appIconRadiusPct?: number;
  selectedObjectId?: string | null;
  showGrid?: boolean;
  snapToGrid?: boolean;
  gridSize?: number;
  interactive?: boolean;
  onSelectObject?: (id: string | null) => void;
  onObjectsChange?: (objects: SvgLogoObject[]) => void;
}

function surfaceColor(
  surface: Props["previewSurface"],
  configured: string
): string {
  if (surface === "black") return "#000000";
  if (surface === "white") return "#ffffff";
  return configured;
}

function renderObject(object: SvgLogoObject, isInteractive: boolean) {
  const pointerClass = isInteractive ? "cursor-move" : "";
  if (object.type === "text") {
    return (
      <text
        key={object.id}
        x={object.x}
        y={object.y}
        fontFamily={object.fontFamily}
        fontSize={object.fontSize}
        fontWeight={object.fontWeight}
        fill={object.fill}
        opacity={object.opacity}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`rotate(${object.rotation} ${object.x} ${object.y})`}
        className={pointerClass}
      >
        {object.text}
      </text>
    );
  }
  if (object.type === "circle") {
    return (
      <circle
        key={object.id}
        cx={object.cx}
        cy={object.cy}
        r={object.radius}
        fill={object.fill}
        opacity={object.opacity}
        transform={`rotate(${object.rotation} ${object.cx} ${object.cy})`}
        className={pointerClass}
      />
    );
  }
  const cx = object.x + object.width / 2;
  const cy = object.y + object.height / 2;
  return (
    <rect
      key={object.id}
      x={object.x}
      y={object.y}
      width={object.width}
      height={object.height}
      rx={object.radius}
      ry={object.radius}
      fill={object.fill}
      opacity={object.opacity}
      transform={`rotate(${object.rotation} ${cx} ${cy})`}
      className={pointerClass}
    />
  );
}

export function LogoForgeSvgCanvas({
  objects,
  renderSize,
  background,
  previewSurface,
  previewShowBackground,
  appIconRadiusPct = 0,
  selectedObjectId = null,
  showGrid = false,
  snapToGrid = false,
  gridSize = 64,
  interactive = false,
  onSelectObject,
  onObjectsChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const objectsRef = useRef(objects);
  const [dragState, setDragState] = useState<{
    id: string;
    x: number;
    y: number;
    objects: SvgLogoObject[];
  } | null>(null);

  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  const eventToPoint = useCallback((event: PointerEvent<SVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scale = SVG_LOGO_VIEWBOX_SIZE / rect.width;
    return {
      x: (event.clientX - rect.left) * scale,
      y: (event.clientY - rect.top) * scale,
    };
  }, []);

  const handleObjectPointerDown = (
    object: SvgLogoObject,
    event: PointerEvent<SVGElement>
  ) => {
    if (!interactive || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = eventToPoint(event);
    setDragState({
      id: object.id,
      x: point.x,
      y: point.y,
      objects: objectsRef.current,
    });
    onSelectObject?.(object.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!interactive || !dragState || !onObjectsChange) return;
    const point = eventToPoint(event);
    const dx = point.x - dragState.x;
    const dy = point.y - dragState.y;
    onObjectsChange(
      dragState.objects.map((object) =>
        object.id === dragState.id
          ? snapToGrid
            ? snapSvgObjectToGrid(moveSvgObject(object, dx, dy), gridSize)
            : moveSvgObject(object, dx, dy)
          : object
      )
    );
  };

  const endDrag = () => setDragState(null);

  const backgroundColor = previewShowBackground
    ? surfaceColor(previewSurface, background)
    : "transparent";
  const radiusPct = Math.max(0, Math.min(50, appIconRadiusPct));
  const appIconRadiusPx = (radiusPct / 100) * renderSize;
  const selectedObject =
    interactive && selectedObjectId
      ? objects.find((object) => object.id === selectedObjectId)
      : null;
  const selectedBounds = selectedObject ? svgObjectBounds(selectedObject) : null;
  const normalizedGridSize = Math.max(8, Math.min(256, gridSize));
  const gridLines = [];
  for (let pos = normalizedGridSize; pos < SVG_LOGO_VIEWBOX_SIZE; pos += normalizedGridSize) {
    gridLines.push(pos);
  }

  return (
    <div
      className="relative flex items-center justify-center overflow-hidden"
      style={{
        background: backgroundColor,
        borderRadius: appIconRadiusPx,
        width: renderSize,
        height: renderSize,
      }}
    >
      <svg
        ref={svgRef}
        width={renderSize}
        height={renderSize}
        viewBox={`0 0 ${SVG_LOGO_VIEWBOX_SIZE} ${SVG_LOGO_VIEWBOX_SIZE}`}
        className={`block ${interactive ? "cursor-default" : ""}`}
        style={{ touchAction: interactive ? "none" : undefined }}
        onPointerDown={() => interactive && onSelectObject?.(null)}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {interactive && showGrid && (
          <g pointerEvents="none">
            {gridLines.map((pos) => (
              <g key={pos}>
                <line
                  x1={pos}
                  y1={0}
                  x2={pos}
                  y2={SVG_LOGO_VIEWBOX_SIZE}
                  stroke="hsl(var(--foreground))"
                  strokeOpacity={0.1}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={0}
                  y1={pos}
                  x2={SVG_LOGO_VIEWBOX_SIZE}
                  y2={pos}
                  stroke="hsl(var(--foreground))"
                  strokeOpacity={0.1}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          </g>
        )}
        {interactive && (
          <g pointerEvents="none">
            <line
              x1={SVG_LOGO_CENTER}
              y1={0}
              x2={SVG_LOGO_CENTER}
              y2={SVG_LOGO_VIEWBOX_SIZE}
              stroke="hsl(var(--primary))"
              strokeOpacity={0.55}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              y1={SVG_LOGO_CENTER}
              x2={SVG_LOGO_VIEWBOX_SIZE}
              y2={SVG_LOGO_CENTER}
              stroke="hsl(var(--primary))"
              strokeOpacity={0.55}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
        {objects.map((object) => (
          <g
            key={object.id}
            onPointerDown={(event) => handleObjectPointerDown(object, event)}
          >
            {renderObject(object, interactive)}
          </g>
        ))}
        {selectedBounds && (
          <rect
            x={selectedBounds.x}
            y={selectedBounds.y}
            width={selectedBounds.width}
            height={selectedBounds.height}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth={8}
            strokeDasharray="18 14"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  );
}

export default LogoForgeSvgCanvas;
