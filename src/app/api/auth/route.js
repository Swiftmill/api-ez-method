// route.js — Proxy d'authentification Supabase
// Gère login, signup, logout, et récupération de profil.
// Protégé contre les erreurs de build Vercel.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ── INITIALISATION SÉCURISÉE ──────────────────────────────────────────────
// On utilise des "placeholders" pour éviter que Vercel ne plante au moment 
// de la compilation (build) si les variables ne sont pas encore chargées.
const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'placeholder_key';
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(request) {
  // Vérification stricte UNIQUEMENT lors de l'exécution d'une vraie requête
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return NextResponse.json({ status: 'error', message: 'Variables Supabase manquantes sur le serveur' }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { action } = body;

    // ── LOGIN ─────────────────────────────────────────────────────────────────
    if (action === 'login') {
      const { email, password } = body;
      if (!email || !password) {
        return NextResponse.json({ status: 'error', message: 'Email et mot de passe requis' }, { status: 400 });
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        return NextResponse.json({ status: 'error', message: error.message }, { status: 401 });
      }

      // Récupérer le profil de l'utilisateur
      const profile = await fetchProfile(data.user.id, data.session.access_token);

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
      if (!email || !password) {
        return NextResponse.json({ status: 'error', message: 'Email et mot de passe requis' }, { status: 400 });
      }

      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        return NextResponse.json({ status: 'error', message: error.message }, { status: 400 });
      }

      // Si session disponible immédiatement (email non confirmé requis)
      if (data.session) {
        const profile = await fetchProfile(data.user.id, data.session.access_token);
        return NextResponse.json({
          status: 'success',
          session_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at,
          user: { email: data.user.email, id: data.user.id },
          profile
        });
      }

      // Email de confirmation envoyé
      return NextResponse.json({
        status: 'confirm_email',
        message: 'Vérifiez vos emails pour confirmer votre inscription.'
      });
    }

    // ── LOGOUT ────────────────────────────────────────────────────────────────
    if (action === 'logout') {
      const { session_token } = body;
      if (session_token) {
        // Invalider le token côté Supabase
        const userSupabase = getAuthenticatedClient(session_token);
        await userSupabase.auth.signOut();
      }
      return NextResponse.json({ status: 'success', message: 'Déconnecté' });
    }

    // ── REFRESH ───────────────────────────────────────────────────────────────
    if (action === 'refresh') {
      const { refresh_token } = body;
      if (!refresh_token) {
        return NextResponse.json({ status: 'error', message: 'refresh_token manquant' }, { status: 400 });
      }

      const { data, error } = await supabase.auth.refreshSession({ refresh_token });
      if (error || !data.session) {
        return NextResponse.json({ status: 'error', message: 'Session expirée, reconnectez-vous' }, { status: 401 });
      }

      const profile = await fetchProfile(data.user.id, data.session.access_token);

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
      const user = await verifyToken(session_token);
      if (!user) {
        return NextResponse.json({ status: 'error', message: 'Session invalide ou expirée' }, { status: 401 });
      }

      const profile = await fetchProfile(user.id, session_token);
      return NextResponse.json({
        status: 'success',
        user: { email: user.email, id: user.id },
        profile
      });
    }

    // ── SYNC SETTINGS ─────────────────────────────────────────────────────────
    if (action === 'syncSettings') {
      const { session_token, theme } = body;
      const user = await verifyToken(session_token);
      if (!user) {
        return NextResponse.json({ status: 'error', message: 'Session invalide ou expirée' }, { status: 401 });
      }

      const { error } = await supabase
        .from('profiles')
        .update({ settings: { theme }, updated_at: new Date().toISOString() })
        .eq('id', user.id);

      if (error) throw error;
      return NextResponse.json({ status: 'success', message: 'Paramètres synchronisés' });
    }

    return NextResponse.json({ status: 'error', message: 'Action inconnue' }, { status: 400 });

  } catch (error) {
    console.error('[/api/auth] Erreur:', error);
    return NextResponse.json({ status: 'error', message: 'Erreur serveur: ' + error.message }, { status: 500 });
  }
}

// Endpoint pour incrémenter le compteur d'uploads (appelé après un patch réussi)
export async function PATCH(request) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return NextResponse.json({ status: 'error', message: 'Variables Supabase manquantes' }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { session_token } = body;

    const user = await verifyToken(session_token);
    if (!user) {
      return NextResponse.json({ status: 'error', message: 'Session invalide' }, { status: 401 });
    }

    // Fetch current settings
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('settings, tier')
      .eq('id', user.id)
      .single();

    if (error) throw error;
    if (profile.tier === 'vip') {
      return NextResponse.json({ status: 'success', message: 'VIP — pas de limite' });
    }

    const settings = profile.settings || {};
    const uploads = settings.uploads || [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = uploads.filter(t => new Date(t) > sevenDaysAgo);
    recent.push(new Date().toISOString());
    settings.uploads = recent;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ settings, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) throw updateError;
    return NextResponse.json({ status: 'success', uploads_count: recent.length });

  } catch (error) {
    console.error('[/api/auth PATCH] Erreur:', error);
    return NextResponse.json({ status: 'error', message: error.message }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function verifyToken(sessionToken) {
  if (!sessionToken) return null;
  try {
    const { data, error } = await supabase.auth.getUser(sessionToken);
    if (error || !data.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

function getAuthenticatedClient(sessionToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${sessionToken}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

async function fetchProfile(userId, sessionToken) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('tier, is_banned, expires_at, settings, custom_max_uploads')
      .eq('id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || { tier: 'free', is_banned: false, expires_at: null, settings: {}, custom_max_uploads: null };
  } catch {
    return { tier: 'free', is_banned: false, expires_at: null, settings: {}, custom_max_uploads: null };
  }
}