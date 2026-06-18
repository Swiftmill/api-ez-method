import { NextResponse } from 'next/server';
import { patchMoov } from './mp4-patcher';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export async function POST(request) {
  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json({ status: 'error', message: 'Variables d\'environnement manquantes sur le serveur.' }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { session_token, moovBase64, otherBoxesSizeBeforeMdat, mdatStart, mdatEnd } = body;

    // 1. Vérification de la session via Supabase côté serveur
    if (!session_token) {
      return NextResponse.json({ status: 'error', message: 'Session manquante — reconnectez-vous' }, { status: 401 });
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(session_token);
    if (authError || !userData?.user) {
      return NextResponse.json({ status: 'error', message: 'Session expirée ou invalide — reconnectez-vous' }, { status: 401 });
    }

    const userId = userData.user.id;

    // 2. Vérifier le profil et les droits d'accès
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('tier, is_banned, expires_at, settings, custom_max_uploads')
      .eq('id', userId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      throw profileError;
    }

    const isDev = process.env.NODE_ENV === 'development';
    const tier = isDev ? 'vip' : (profile?.tier || 'free');
    const isBanned = profile?.is_banned || false;

    if (isBanned) {
      return NextResponse.json({ status: 'error', message: 'Compte banni' }, { status: 403 });
    }

    const isExpired = profile?.expires_at ? new Date(profile.expires_at) < new Date() : false;

    if (tier === 'free' || (tier === 'premium' && isExpired)) {
      return NextResponse.json({ status: 'error', message: 'Abonnement Premium ou VIP requis' }, { status: 403 });
    }

    // Vérifier la limite d'uploads pour les Premium
    if (tier === 'premium') {
      const maxUploads = (profile?.custom_max_uploads > 0) ? profile.custom_max_uploads : 7;
      const uploads = profile?.settings?.uploads || [];
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recentUploads = uploads.filter(t => new Date(t) > sevenDaysAgo);
      if (recentUploads.length >= maxUploads) {
        return NextResponse.json({
          status: 'error',
          message: `Limite hebdomadaire atteinte (${recentUploads.length}/${maxUploads})`
        }, { status: 429 });
      }
    }

    if (!moovBase64) {
      return NextResponse.json({ status: 'error', message: 'Données MP4 manquantes' }, { status: 400 });
    }

    // 3. Application du patch binaire sur le serveur
    const moovBuffer = Buffer.from(moovBase64, 'base64');
    const { patchedMoov, fakeCount } = patchMoov(
      moovBuffer,
      otherBoxesSizeBeforeMdat,
      mdatStart,
      mdatEnd
    );

    const patchedMoovBase64 = Buffer.from(patchedMoov).toString('base64');

    return NextResponse.json({
      status: 'success',
      message: 'Patch appliqué avec succès',
      patchedMoovBase64,
      fakeCount
    }, { status: 200 });

  } catch (error) {
    console.error('Erreur serveur lors du traitement :', error);
    return NextResponse.json({ status: 'error', message: 'Erreur serveur : ' + error.message }, { status: 500 });
  }
}
