import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const supabaseConfigured = Boolean(url && key)

// Everything this app owns lives in the `mind` schema.
export const supabase = supabaseConfigured
  ? createClient(url!, key!, { db: { schema: 'mind' } })
  : null
