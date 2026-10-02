const QRCode = require('qrcode');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Metodo nao permitido.' });
    }

    const data = String(req.query?.data || '').trim();
    if (!data) return res.status(400).json({ error: 'Conteudo do QR Code nao informado.' });
    if (data.length > 1800) return res.status(400).json({ error: 'Conteudo do QR Code muito longo.' });

    const svg = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color: { dark: '#111827', light: '#FFFFFF' }
    });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    return res.status(200).send(svg);
  } catch (err) {
    console.error('fleet-qr error', err);
    return res.status(500).json({ error: 'Nao foi possivel gerar o QR Code.' });
  }
};
