// Import d'un lot d'étiquettes.
//
// Luc dépose ses PDF dans le dossier AVAILABLE de Dropbox, sans contrainte
// de nommage. Cet endpoint les lit, en extrait le numéro de suivi imprimé
// sur chaque étiquette, et ajoute les lignes correspondantes dans
// INVENTORY.csv.
//
// Aucune bibliothèque PDF n'est nécessaire : le numéro se trouve dans un
// flux compressé que zlib, intégré à Node, sait décompresser.
//
// Traitement par lots : cinquante PDF téléchargés d'un coup dépasseraient
// le temps d'exécution alloué à une fonction Vercel.

import { inflateSync } from 'node:zlib';
import { listAvailableFiles, downloadFile, addLabels, getKnownFiles } from '../lib/dropbox.js';

const LOT = 10;

// Motifs des numéros de suivi selon le transporteur. Le premier qui
// correspond gagne : un nouveau transporteur s'ajoute ici, sans toucher
// au reste.
const MOTIFS = [
  { nom: 'Chronopost', regex: /XT\d{9}TS/g },
  { nom: 'Chronopost', regex: /[A-Z]{2}\d{9}[A-Z]{2}/g },
  { nom: 'Colissimo', regex: /\d{4}\s?\d{4}\s?[A-Z]\d{3}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{3}[A-Z]/g }
];

// Extrait les chaînes lisibles d'un PDF : texte en clair, flux compressés,
// et fragments entre parenthèses que l'encodage PDF disperse.
function texteDuPdf(buffer) {
  const morceaux = [buffer.toString('latin1')];

  let i = 0;
  while (i < buffer.length) {
    const debut = buffer.indexOf('stream', i);
    if (debut < 0) break;
    let d = debut + 6;
    if (buffer[d] === 0x0d) d++;
    if (buffer[d] === 0x0a) d++;

    const fin = buffer.indexOf('endstream', d);
    if (fin < 0) break;

    try {
      const clair = inflateSync(buffer.subarray(d, fin)).toString('latin1');
      morceaux.push(clair);
      // Le texte d'un PDF est souvent découpé en (fragments) successifs.
      const entreParentheses = clair.match(/\((.*?)\)/g);
      if (entreParentheses) {
        morceaux.push(entreParentheses.map((s) => s.slice(1, -1)).join(''));
      }
    } catch {
      // Flux non compressé ou format inconnu : on l'ignore.
    }

    i = fin + 9;
  }

  return morceaux.join('\n');
}

function trouverSuivi(buffer) {
  const texte = texteDuPdf(buffer);
  for (const { nom, regex } of MOTIFS) {
    const trouves = [...new Set(texte.match(regex) || [])];
    if (trouves.length === 1) return { tracking: trouves[0].replace(/\s/g, ''), transporteur: nom };
    // Plusieurs numéros différents : on ne devine pas, l'humain tranchera.
    if (trouves.length > 1) return { ambigu: trouves, transporteur: nom };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://misu-sneakers.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Misu-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const attendu = process.env.MISU_STAFF_TOKEN;
  if (!attendu || req.headers['x-misu-token'] !== attendu) {
    return res.status(401).json({ error: 'Accès refusé.' });
  }

  try {
    const [fichiers, connus] = await Promise.all([listAvailableFiles(), getKnownFiles()]);

    // Un PDF déjà inventorié n'est pas réimporté : l'opération peut être
    // relancée sans créer de doublons.
    const restants = fichiers.filter((f) => !connus.has(f));

    if (!restants.length) {
      return res.status(200).json({
        termine: true,
        importes: 0,
        restants: 0,
        message: 'Toutes les étiquettes du dossier sont déjà inventoriées.'
      });
    }

    const lot = restants.slice(0, LOT);
    const nouvelles = [];
    const problemes = [];

    for (const fichier of lot) {
      try {
        const buffer = await downloadFile(fichier);
        const trouve = trouverSuivi(buffer);

        if (!trouve) {
          problemes.push({ fichier, raison: 'Aucun numéro de suivi lisible.' });
          continue;
        }
        if (trouve.ambigu) {
          problemes.push({
            fichier,
            raison: `Plusieurs numéros trouvés : ${trouve.ambigu.join(', ')}. À saisir à la main.`
          });
          continue;
        }

        nouvelles.push({ tracking: trouve.tracking, pdfFile: fichier });
      } catch (err) {
        problemes.push({ fichier, raison: err.message });
      }
    }

    const ajoutees = nouvelles.length ? await addLabels(nouvelles) : [];

    return res.status(200).json({
      termine: restants.length <= LOT,
      importes: ajoutees.length,
      restants: Math.max(0, restants.length - lot.length),
      etiquettes: ajoutees,
      problemes
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
}
