// supabase-server.js — Client Supabase côté serveur (variables d'environnement)
// Les credentials ne sont JAMAIS exposés à l'extension cliente.

import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Variables d\'environnement SUPABASE_URL et SUPABASE_ANON_KEY manquantes');
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);
