import { OPTIONS_ROUTES, type OptionsRouteId } from '../../shared/routes';

interface SidebarProps {
  activeRoute: OptionsRouteId;
  isConfigured: boolean;
}

const SIDEBAR_ITEMS = OPTIONS_ROUTES.filter((route) => route.showInSidebar);

export function Sidebar({ activeRoute, isConfigured }: SidebarProps) {
  return (
    <aside className="sidebar-region flex w-70 shrink-0 flex-col justify-between border-r border-sidebar-border bg-sidebar text-slate-200">
      <div>
        <div className="flex items-center gap-3.5 border-b border-sidebar-border px-5 py-6">
          {/* Icon placeholder: Brand Logo (48x48) */}
          <div className="h-12 w-12 shrink-0 rounded-lg bg-sidebar-active" aria-hidden="true" />
          <div>
            <p className="text-lg font-bold leading-tight text-white">reMarkable</p>
            <p className="mt-0.5 text-sm text-slate-400">OneNote Sync</p>
            <span className="mt-1.5 inline-block rounded bg-sidebar-active px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
              v0.1.0
            </span>
          </div>
        </div>

        <nav aria-label="Primary" className="py-3">
          <ul className="space-y-0.5">
            {SIDEBAR_ITEMS.map((item) => {
              const isSelected = activeRoute === item.id;
              return (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    aria-current={isSelected ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-3 px-5 py-3 text-sm transition-colors ${
                      isSelected
                        ? 'bg-sidebar-active font-semibold text-white'
                        : 'text-slate-300 hover:bg-sidebar-hover hover:text-white'
                    }`}
                  >
                    {/* Icon placeholder: Navigation item (18x18) */}
                    <div
                      className={`h-4.5 w-4.5 shrink-0 rounded-xs ${
                        isSelected ? 'bg-blue-400/40' : 'bg-slate-600/60'
                      }`}
                      aria-hidden="true"
                    />
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      <div className="border-t border-sidebar-border px-5 py-4">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span
            className={`h-2 w-2 rounded-full ${
              isConfigured ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
            aria-hidden="true"
          />
          <span>{isConfigured ? 'Accounts Connected' : 'Setup Required'}</span>
        </div>

        {!isConfigured ? (
          <a
            href="#setup"
            aria-current={activeRoute === 'setup' ? 'page' : undefined}
            className="mt-3 inline-flex min-h-8 w-full items-center justify-center rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
          >
            Run Account Setup
          </a>
        ) : null}
      </div>
    </aside>
  );
}

