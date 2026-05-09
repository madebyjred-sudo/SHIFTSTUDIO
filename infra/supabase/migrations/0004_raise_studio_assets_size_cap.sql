-- Raise studio-workspace-assets bucket from 100MB → 500MB.
-- Reason: users hit the silent 413 ceiling on large PDFs (CCCR proposals,
-- design briefs with embedded images). Vercel function has 60s on Pro
-- which is plenty for downloading 500MB server-side and extracting text.
update storage.buckets
   set file_size_limit = 524288000
 where id = 'studio-workspace-assets';
