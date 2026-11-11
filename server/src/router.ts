// Decides whether a task needs the team or a quick answer. Routing small requests to one cheap reply is the
// single biggest token saver for agent apps; the quick agent can still hand the task to the team when it needs
// files or tools (it answers NEEDS_TEAM), so a wrong guess costs one short reply, not a wrong result.

export const NEEDS_TEAM = 'NEEDS_TEAM';

// Words that mean "do work on files or the machine" (English and Turkish stems).
const WORK = /\b(create|implement|build|fix|refactor|add|remove|delete|rename|update|change|edit|run|test|deploy|install|migrate|debug|review|commit|merge|push|scaffold|setup|set up|configure|optimi[sz]e|convert|open the|in this (repo|project|folder|codebase))\b|\b(oluştur|yap(ar|ın|)\b|ekle|düzelt|sil|değiştir|güncelle|çalıştır|kur\b|kurulum|test et|incele|refaktör|taşı|dönüştür|geliştir|bu (repo|proje|klasör))/i;
// Things that point at files or code.
const CODE = /```|\b[\w./\\-]+\.(ts|tsx|js|jsx|mjs|py|cs|go|rs|java|kt|rb|php|json|ya?ml|toml|md|css|html|sql|sh|ps1|csproj|sln)\b|[\\/][\w.-]+[\\/]/i;
const QUESTION = /\?\s*$|^(what|why|how|who|when|where|which|is|are|can|could|should|does|do|explain|define|tell me|ne\b|neden|nasıl|kim|hangi|nedir|mi\b|mı\b|mu\b|mü\b|açıkla|anlat)/i;

export interface Route { mode: 'quick' | 'team'; reason: string }

/** Cheap, local and instant. Errs towards the team: only clear questions and chat go the quick way. */
export function classify(task: string, files: string[] = []): Route {
  const text = task.trim();
  if (files.some((f) => !/\.(png|jpe?g|gif|webp)$/i.test(f))) return { mode: 'team', reason: 'files are attached' };
  if (text.length > 400) return { mode: 'team', reason: 'long, detailed task' };
  if (CODE.test(text)) return { mode: 'team', reason: 'mentions code or files' };
  if (WORK.test(text)) return { mode: 'team', reason: 'asks for work to be done' };
  if (QUESTION.test(text) || text.split(/\s+/).length <= 12) return { mode: 'quick', reason: 'a question that needs no files or tools' };
  return { mode: 'team', reason: 'not clearly a simple question' };
}
