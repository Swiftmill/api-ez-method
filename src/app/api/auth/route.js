// route.js — Proxy d'authentification Supabase
// Protection maximale contre les crashs de build Next.js (Turbopack)

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ── FONCTION SÉCURISÉE ──────────────────────────────────────────────────────
// Cette fonction ne s'exécute JAMAIS pendant le build.
// Elle est appelée uniquement lors d'une vraie requête.
function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-supabase-runtime': 'server' }
    }
  });
}

export async function POST(request) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ status: 'error', message: 'Variables Vercel manquantes' }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { action } = body;

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { email, password } = body;
      if (!email || !password) return NextResponse.json({ status: 'error', message: 'Requis' }, { status: 400 });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return NextResponse.json({ status: 'error', message: error.message }, { status: 401 });

      const profile = await fetchProfile(supabase, data.user.id);

      return NextResponse.json({
        status: 'success',
        session_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: { email: data.user.email, id: data.user.id },
        profile
      });
    }

    // ── SIGNUP ────────────────────────────────────────────────────────────────
    if (action === 'signup') {
      const { email, password } = body;
      if (!email || !password) return NextResponse.json({ status: 'error', message: 'Requis' }, { status: 400 });

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return NextResponse.json({ status: 'error', message: error.message }, { status: 400 });

      if (data.session) {
        const profile = await fetchProfile(supabase, data.user.id);
        return NextResponse.json({
          status: 'success',
          session_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          user: { email: data.user.email, id: data.user.id },
          profile
        });
      }
      return NextResponse.json({ status: 'confirm_email', message: 'Vérifiez vos emails.' });
    }

    // ── LOGOUT ────────────────────────────────────────────────────────────────
    if (action === 'logout') {
      const { session_token } = body;
      if (session_token) {
        const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${session_token}` } }
        });
        await userClient.auth.signOut();
      }
      return NextResponse.json({ status: 'success', message: 'Déconnecté' });
    }

    // ── REFRESH ───────────────────────────────────────────────────────────────
    if (action === 'refresh') {
      const { refresh_token } = body;
      if (!refresh_token) return NextResponse.json({ status: 'error', message: 'Token manquant' }, { status: 400 });

      const { data, error } = await supabase.auth.refreshSession({ refresh_token });
      if (error || !data.session) return NextResponse.json({ status: 'error', message: 'Session expirée' }, { status: 401 });

      const profile = await fetchProfile(supabase, data.user.id);

      return NextResponse.json({
        status: 'success',
        session_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: { email: data.user.email, id: data.user.id },
        profile
      });
    }

    // ── GET PROFILE ───────────────────────────────────────────────────────────
    if (action === 'getProfile') {
      const { session_token } = body;
      const user = await verifyToken(supabase, session_token);
      if (!user) return NextResponse.json({ status: 'error', message: 'Session invalide' }, { status: 401 });

      const profile = await fetchProfile(supabase, user.id);
      return NextResponse.json({ status: 'success', user: { email: user.email, id: user.id }, profile });
    }

    // ── SYNC SETTINGS ─────────────────────────────────────────────────────────
    if (action === 'syncSettings') {
      const { session_token, theme } = body;
      const user = await verifyToken(supabase, session_token);
      if (!user) return NextResponse.json({ status: 'error', message: 'Session invalide' }, { status: 401 });

      const { error } = await supabase.from('profiles').update({ settings: { theme }, updated_at: new Date().toISOString() }).eq('id', user.id);
      if (error) throw error;
      return NextResponse.json({ status: 'success', message: 'Synchronisé' });
    }

    return NextResponse.json({ status: 'error', message: 'Action inconnue' }, { status: 400 });

  } catch (error) {
    console.error('[/api/auth] Erreur:', error);
    return NextResponse.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ status: 'error', message: 'Variables manquantes' }, { status: 500 });

  try {
    const body = await request.json();
    const { session_token } = body;

    const user = await verifyToken(supabase, session_token);
    if (!user) return NextResponse.json({ status: 'error', message: 'Session invalide' }, { status: 401 });

    const { data: profile, error } = await supabase.from('profiles').select('settings, tier').eq('id', user.id).single();
    if (error) throw error;

    if (profile.tier === 'vip') return NextResponse.json({ status: 'success', message: 'VIP' });

    const settings = profile.settings || {};
    const uploads = settings.uploads || [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = uploads.filter(t => new Date(t) > sevenDaysAgo);

    recent.push(new Date().toISOString());
    settings.uploads = recent;

    const { error: updateError } = await supabase.from('profiles').update({ settings, updated_at: new Date().toISOString() }).eq('id', user.id);
    if (updateError) throw updateError;

    return NextResponse.json({ status: 'success', uploads_count: recent.length });

  } catch (error) {
    return NextResponse.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function verifyToken(supabase, sessionToken) {
  if (!sessionToken) return null;
  try {
    const { data, error } = await supabase.auth.getUser(sessionToken);
    if (error || !data.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

async function fetchProfile(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('tier, is_banned, expires_at, settings, custom_max_uploads')
      .eq('id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    
    const isDev = process.env.NODE_ENV === 'development';
    const profile = data || { tier: 'free', is_banned: false, expires_at: null, settings: {}, custom_max_uploads: null };
    if (isDev) {
      profile.tier = 'vip';
    }
    return profile;
  } catch {
    const isDev = process.env.NODE_ENV === 'development';
    return { tier: isDev ? 'vip' : 'free', is_banned: false, expires_at: null, settings: {}, custom_max_uploads: null };
  }
}