import { createClient } from '@supabase/supabase-js';

// A service-role key must never be placed in a browser bundle.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
export const cloudEnabled = Boolean(supabase);
