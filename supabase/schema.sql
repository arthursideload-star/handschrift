-- Handschrift cloud sync: one row per user with their drawn letters,
-- settings and GoodNotes template. Applied as migration "handschrift_fonts".
-- Row Level Security: every user can only see and change their own row.

create table if not exists public.fonts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  font       jsonb,                      -- { version, glyphs: { "a": [ { s: [...] } ] } }
  settings   jsonb,                      -- pen, paper, spacing …
  template   jsonb,                      -- GoodNotes template { name, b64 } or null
  updated_at timestamptz not null default now()
);

comment on table public.fonts is 'Handschrift app: per-user handwriting font, settings and GoodNotes template.';

-- Server-side timestamp so devices can tell which copy is newer.
create or replace function public.fonts_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists fonts_touch_updated_at on public.fonts;
create trigger fonts_touch_updated_at
  before insert or update on public.fonts
  for each row execute function public.fonts_touch_updated_at();

alter table public.fonts enable row level security;

revoke all on public.fonts from anon;
grant select, insert, update, delete on public.fonts to authenticated;

drop policy if exists "fonts: read own row" on public.fonts;
create policy "fonts: read own row" on public.fonts
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "fonts: insert own row" on public.fonts;
create policy "fonts: insert own row" on public.fonts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "fonts: update own row" on public.fonts;
create policy "fonts: update own row" on public.fonts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "fonts: delete own row" on public.fonts;
create policy "fonts: delete own row" on public.fonts
  for delete to authenticated
  using ((select auth.uid()) = user_id);
