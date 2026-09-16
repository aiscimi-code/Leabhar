import Link from 'next/link';
import { HELP_SECTIONS } from '@/domain/help/content';
import { Page, Panel } from '@/components/primitives';

export const dynamic = 'force-static';

/** Help centre (README §40). */
export default function HelpPage() {
  return (
    <Page
      title="Help centre"
      subtitle="Practical explanations for running the books of a small Irish company."
    >
      <div className="grid grid-cols-2 gap-4 items-start">
        {HELP_SECTIONS.map((section) => (
          <Panel key={section.slug} title={section.title}>
            <div className="divide-y divide-line">
              {section.articles.map((article) => (
                <Link
                  key={article.slug}
                  href={`/help/${section.slug}/${article.slug}`}
                  className="block px-4 py-2.5 hover:bg-surface-sunken"
                >
                  <div className="font-medium text-accent">{article.title}</div>
                  <div className="text-ink-muted mt-0.5">{article.summary}</div>
                </Link>
              ))}
            </div>
          </Panel>
        ))}
      </div>
    </Page>
  );
}
