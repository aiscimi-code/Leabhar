import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HELP_SECTIONS, findArticle } from '@/domain/help/content';
import { Page, Panel, LinkButton } from '@/components/primitives';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return HELP_SECTIONS.flatMap((section) =>
    section.articles.map((article) => ({ section: section.slug, article: article.slug })));
}

export default async function HelpArticlePage({ params }: {
  params: Promise<{ section: string; article: string }>;
}) {
  const { section: sectionSlug, article: articleSlug } = await params;
  const article = findArticle(sectionSlug, articleSlug);
  if (!article) notFound();

  const section = HELP_SECTIONS.find((s) => s.slug === sectionSlug)!;
  const others = section.articles.filter((a) => a.slug !== articleSlug);

  return (
    <Page
      title={article.title}
      subtitle={<Link href="/help" className="text-accent hover:underline">{section.title}</Link>}
      actions={<LinkButton href="/help">All help</LinkButton>}
    >
      <Panel>
        <div className="px-5 py-4 max-w-3xl">
          {article.body.map((paragraph, index) => (
            <p key={index} className="text-ink mb-3 last:mb-0 leading-relaxed text-[13.5px]">
              {paragraph}
            </p>
          ))}
        </div>
      </Panel>

      {others.length > 0 && (
        <Panel title={`More in ${section.title}`}>
          <div className="divide-y divide-line">
            {others.map((other) => (
              <Link key={other.slug} href={`/help/${section.slug}/${other.slug}`}
                className="block px-4 py-2.5 hover:bg-surface-sunken">
                <div className="font-medium text-accent">{other.title}</div>
                <div className="text-ink-muted mt-0.5">{other.summary}</div>
              </Link>
            ))}
          </div>
        </Panel>
      )}
    </Page>
  );
}
