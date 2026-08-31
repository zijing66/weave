import { type AssetScope, type McpServerConfig, type McpUpdate } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Server, Trash2 } from 'lucide-react';

export interface McpRow {
  name: string;
  config: McpServerConfig;
  scope: AssetScope;
}

export function McpGrid({
  servers,
  updates,
  empty,
  onUninstallMcp,
}: {
  servers: McpRow[];
  /** Update info already filtered to this mode's scope. */
  updates?: McpUpdate[];
  empty: string;
  onUninstallMcp: (name: string, scope: AssetScope) => void;
}) {
  if (servers.length === 0) {
    return (
      <p className="text-xs text-neutral-600 border border-dashed border-white/[0.06] rounded-md p-3">
        {empty}
      </p>
    );
  }

  const isOutdated = (name: string) => !!updates?.find((u) => u.name === name && u.outdated);

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-neutral-400 uppercase">
        MCP Servers ({servers.length})
      </h2>
      <div className="grid grid-cols-2 gap-3 items-start">
        {servers.map((s) => {
          const outdated = isOutdated(s.name);
          return (
            <Card key={`${s.scope}-${s.name}`}>
              <CardHeader className="items-center gap-2">
                <Server className="h-3.5 w-3.5 shrink-0 text-pink-400" />
                <CardTitle className="truncate">{s.name}</CardTitle>
                {outdated && (
                  <Badge variant="warning" className="ml-1">
                    update
                  </Badge>
                )}
                <button
                  onClick={() => onUninstallMcp(s.name, s.scope)}
                  className="ml-auto text-neutral-500 hover:text-red-400 shrink-0"
                  title={`Remove ${s.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </CardHeader>
              <CardContent className="pt-0 text-xs font-mono text-neutral-400 break-all">
                <span className="text-neutral-300">{s.config.command}</span>
                {s.config.args && s.config.args.length > 0 && (
                  <span className="text-neutral-500"> {s.config.args.join(' ')}</span>
                )}
                {s.config.env && Object.keys(s.config.env).length > 0 && (
                  <div className="mt-1 text-neutral-600">
                    env: {Object.keys(s.config.env).join(', ')}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
