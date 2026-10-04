import { useEffect } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ChainEdge, ChainNode } from './build-session-chain';
import { taskNodeTypes } from './SessionChainNodes';

/**
 * 事件链画布（哑组件）：ReactFlow 配置对齐 HooksPanel（smoothstep 边、
 * fitView、可拖拽不可连线）。key = viewKey（切会话/切组重建实例 → 首帧 fitView；
 * 同组内事件新增只同步节点，不重置视口/拖拽位置）。
 */
export function SessionFlowCanvas({
  nodes: externalNodes,
  edges: externalEdges,
  viewKey,
  emptyHint,
}: {
  nodes: ChainNode[];
  edges: ChainEdge[];
  /** = 会话id:组id，变更时重建并 fitView。 */
  viewKey: string;
  /** 无数据时的提示（由父级渲染空态时传空数组即可）。 */
  emptyHint?: string;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<ChainNode>(externalNodes);
  const [edges, setEdges] = useEdgesState<ChainEdge>(externalEdges);

  useEffect(() => {
    setNodes(externalNodes);
    setEdges(externalEdges);
  }, [externalNodes, externalEdges, setNodes, setEdges]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        key={viewKey}
        nodes={nodes}
        onNodesChange={onNodesChange}
        edges={edges}
        nodeTypes={taskNodeTypes}
        fitView
        minZoom={0.15}
        maxZoom={1.5}
        nodesDraggable
        nodesConnectable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1.5 },
        }}
      >
        <Background gap={14} size={1} color="rgba(255,255,255,0.06)" />
        <Controls showInteractive={false} />
        {emptyHint && !nodes.length ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
            {emptyHint}
          </div>
        ) : null}
      </ReactFlow>
    </div>
  );
}
