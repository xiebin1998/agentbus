import { useEffect, useState, useRef, useCallback } from "react";
import { Button, Card, CardContent } from "@/components/ui";
import { RefreshCw, Clock, Users, ArrowRight } from "lucide-react";

interface GraphData {
  nodes: string[];
  edges: Array<{
    agents: [string, string];
    counts: Record<string, number>;
    last_ts: string;
  }>;
}

interface NodePosition {
  x: number;
  y: number;
}

// 布局算法：圆形布局
function layoutNodes(nodes: string[], width: number, height: number): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2 - 80;

  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    positions.set(node, {
      x: centerX + radius * Math.cos(angle),
      y: centerY + radius * Math.sin(angle),
    });
  });

  return positions;
}

// 提取 client_id 显示名
function displayName(key: string): string {
  const parts = key.split("/");
  return parts.length > 1 ? parts[1] : key;
}

export function Graph() {
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowHours, setWindowHours] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // 响应式尺寸
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        setDimensions({
          width: Math.max(clientWidth - 32, 400),
          height: Math.max(clientHeight - 100, 400),
        });
      }
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, []);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/console/graph?window_hours=${windowHours}`);
      if (!res.ok) throw new Error("获取图谱失败");
      const data = await res.json();
      setGraph(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }, [windowHours]);

  useEffect(() => {
    fetchGraph();
    const interval = setInterval(fetchGraph, 30000); // 30秒刷新
    return () => clearInterval(interval);
  }, [fetchGraph]);

  // 计算节点位置
  const positions = layoutNodes(graph.nodes, dimensions.width, dimensions.height);

  // 计算边的路径
  const getEdgePath = (from: string, to: string) => {
    const fromPos = positions.get(from);
    const toPos = positions.get(to);
    if (!fromPos || !toPos) return "";
    return `M ${fromPos.x} ${fromPos.y} L ${toPos.x} ${toPos.y}`;
  };

  // 获取边的中点位置
  const getMidPoint = (from: string, to: string): NodePosition => {
    const fromPos = positions.get(from);
    const toPos = positions.get(to);
    if (!fromPos || !toPos) return { x: 0, y: 0 };
    return { x: (fromPos.x + toPos.x) / 2, y: (fromPos.y + toPos.y) / 2 };
  };

  // 总消息数
  const totalMessages = graph.edges.reduce((sum, e) => {
    return sum + Object.values(e.counts).reduce((s, c) => s + c, 0);
  }, 0);

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <select
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value))}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              <option value={1}>最近 1 小时</option>
              <option value={6}>最近 6 小时</option>
              <option value={12}>最近 12 小时</option>
              <option value={24}>最近 24 小时</option>
            </select>
          </div>
          <Button variant="outline" size="sm" onClick={fetchGraph} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="h-4 w-4" />
            {graph.nodes.length} 个 Agent
          </span>
          <span className="flex items-center gap-1">
            <ArrowRight className="h-4 w-4" />
            {totalMessages} 条消息
          </span>
        </div>
      </div>

      {/* 图谱区域 */}
      <Card className="flex-1">
        <CardContent className="p-4">
          {error ? (
            <div className="flex h-full items-center justify-center text-red-500">{error}</div>
          ) : loading && graph.nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              加载中...
            </div>
          ) : graph.nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              暂无通信记录
            </div>
          ) : (
            <div ref={containerRef} className="h-full min-h-[400px]">
              <svg
                ref={svgRef}
                width={dimensions.width}
                height={dimensions.height}
                className="overflow-visible"
              >
                {/* 边（连线） */}
                {graph.edges.map((edge, i) => {
                  const [from, to] = edge.agents;
                  const mid = getMidPoint(from, to);
                  const forwardKey = `${from}→${to}`;
                  const reverseKey = `${to}→${from}`;
                  const forwardCount = edge.counts[forwardKey] || 0;
                  const reverseCount = edge.counts[reverseKey] || 0;

                  return (
                    <g key={i}>
                      {/* 连线 */}
                      <path
                        d={getEdgePath(from, to)}
                        fill="none"
                        stroke="hsl(var(--muted-foreground) / 0.3)"
                        strokeWidth={2 + Math.log2(forwardCount + reverseCount + 1)}
                        className="transition-colors hover:stroke-primary"
                      />
                      {/* 双向数字 */}
                      <g transform={`translate(${mid.x}, ${mid.y})`}>
                        {/* 上方数字（正向） */}
                        <rect
                          x={-20}
                          y={-20}
                          width={40}
                          height={16}
                          rx={4}
                          fill="hsl(var(--card))"
                          className="stroke-border stroke-1"
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="middle"
                          y={-12}
                          className="fill-primary text-xs font-medium"
                        >
                          {forwardCount}↑
                        </text>
                        {/* 下方数字（反向） */}
                        <rect
                          x={-20}
                          y={4}
                          width={40}
                          height={16}
                          rx={4}
                          fill="hsl(var(--card))"
                          className="stroke-border stroke-1"
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="middle"
                          y={12}
                          className="fill-secondary-foreground text-xs font-medium"
                        >
                          {reverseCount}↓
                        </text>
                      </g>
                    </g>
                  );
                })}

                {/* 节点（Agent） */}
                {graph.nodes.map((node) => {
                  const pos = positions.get(node);
                  if (!pos) return null;

                  return (
                    <g key={node} transform={`translate(${pos.x}, ${pos.y})`}>
                      {/* 节点圆圈 */}
                      <circle
                        r={24}
                        fill="hsl(var(--primary))"
                        className="cursor-pointer transition-all hover:r-[28]"
                      />
                      {/* 节点文字 */}
                      <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="fill-primary-foreground text-xs font-medium"
                      >
                        {displayName(node).slice(0, 6)}
                      </text>
                      {/* 完整名称提示 */}
                      <title>{node}</title>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}