import { NextResponse } from 'next/server';

export async function POST(request) {
  try {
    // 1. On récupère la clé envoyée par ton extension
    const body = await request.json();
    const userKey = body.licenseKey;

    // 2. ICI : Logique de vérification (ex: appel à ta base de données Supabase)
    // Pour le tuto, on va simuler que la clé valide est "EZ-PREMIUM-2026"
    const isValid = (userKey === "EZ-PREMIUM-2026");

    if (isValid) {
      // 3. La clé est bonne ! On renvoie la clé de déchiffrement secrète.
      return NextResponse.json({ 
        status: "success", 
        message: "Licence valide",
        secretPayload: "CLE_SECRETE_POUR_DEBLOQUER_EZ_CORE" // Ton extension utilisera ça
      }, { status: 200 });
    } else {
      // 4. Mauvaise clé
      return NextResponse.json({ 
        status: "error", 
        message: "Licence invalide ou expirée" 
      }, { status: 403 });
    }

  } catch (error) {
    return NextResponse.json({ status: "error", message: "Erreur serveur" }, { status: 500 });
  }
}
