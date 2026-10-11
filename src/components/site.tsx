import Link from "next/link";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-[15px] font-bold tracking-tight text-foreground">
          abetConnect
        </Link>
        <div className="flex items-center gap-5">
          <Link href="/pricing" className="text-muted hover:text-foreground text-[13px]">Pricing</Link>
          <Link href="/support" className="text-muted hover:text-foreground text-[13px]">Support</Link>
          <Link href="/changelog" className="text-muted hover:text-foreground text-[13px]">Changelog</Link>
          <a href="/login" className="rounded-lg bg-blue-600 text-white hover:bg-blue-500 px-4 py-2 text-sm font-semibold transition">
            Sign in
          </a>
        </div>
      </nav>
    </header>
  );
}

const COLS: [string, [string, string][]][] = [
  ["Product", [["Pricing", "/pricing"], ["Live demo", "/login"], ["Changelog", "/changelog"], ["Support", "/support"]]],
  ["Developers", [["API health", "/api/health"], ["Changelog", "/changelog"]]],
  ["Company", [["Terms", "/terms"], ["Privacy", "/privacy"], ["Contact", "mailto:support@abetworks.in"]]],
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 sm:grid-cols-4">
        <div>
          <p className="text-[15px] font-bold text-foreground">abetConnect</p>
          <p className="text-muted-dim text-[12px] mt-2 max-w-xs">Every channel. One triage queue.</p>
        </div>
        {COLS.map(([title, links]) => (
          <div key={title}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
            <ul className="mt-3 space-y-2">
              {links.map(([label, href]) => (
                <li key={label}>
                  {href.startsWith("/") ? (
                    <Link href={href} className="text-muted hover:text-foreground text-[12px]">{label}</Link>
                  ) : (
                    <a href={href} className="text-muted hover:text-foreground text-[12px]">{label}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-6 py-4 text-muted-dim text-[12px]">© 2026 Abetworks · abetConnect · All systems normal — see <a href="/api/health" className="underline">status</a>.</p>
      </div>
    </footer>
  );
}
