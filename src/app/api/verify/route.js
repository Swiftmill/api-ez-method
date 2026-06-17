import { NextResponse } from 'next/server';
import { patchMoov } from './mp4-patcher';

export async function POST(request) {
  try {
    const body = await request.json();
    const { licenseKey, moovBase64, otherBoxesSizeBeforeMdat, mdatStart, mdatEnd } = body;

    // 1. Vérification de la licence
    // Dans votre production, vous pouvez interroger votre base Supabase
    const isValid = (licenseKey === "EZ-PREMIUM-2026");

    if (!isValid) {
      return NextResponse.json({ 
        status: "error", 
        message: "Licence invalide ou expirée" 
      }, { status: 403 });
    }

    if (!moovBase64) {
      return NextResponse.json({
        status: "error",
        message: "Données MP4 manquantes"
      }, { status: 400 });
    }

    // 2. Conversion du bloc moov Base64 -> Buffer binaire
    const moovBuffer = Buffer.from(moovBase64, 'base64');

    // 3. Application du patch binaire sur le serveur
    const { patchedMoov, fakeCount } = patchMoov(
      moovBuffer,
      otherBoxesSizeBeforeMdat,
      mdatStart,
      mdatEnd
    );

    // 4. Conversion du résultat final en Base64 pour le renvoi
    const patchedMoovBase64 = Buffer.from(patchedMoov).toString('base64');

    return NextResponse.json({ 
      status: "success", 
      message: "Licence valide et fichier patché",
      patchedMoovBase64: patchedMoovBase64,
      fakeCount: fakeCount
    }, { status: 200 });

  } catch (error) {
    console.error("Erreur serveur lors du traitement :", error);
    return NextResponse.json({ 
      status: "error", 
      message: "Erreur serveur : " + error.message 
    }, { status: 500 });
  }
}
