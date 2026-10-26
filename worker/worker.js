// Asystent ofert KRYSAN: pośrednik między stroną oferty.krysan.eu a API Claude.
// Sekrety ustawiane w panelu Cloudflare (Settings -> Variables and Secrets):
//   ANTHROPIC_API_KEY  klucz z console.anthropic.com
//   ACCESS_PIN         kod dostępu wpisywany raz na stronie
const ALLOWED = ["https://oferty.krysan.eu", "https://mojanetia-strona.github.io"];
const MODEL = "claude-sonnet-5-5";

const SYSTEM = `Jesteś asystentem firmy KRYSAN (Stryków), która sprzedaje autotransportery i naczepy Aksoylu.
Pomagasz właścicielowi, Stanisławowi, przygotować ofertę handlową w generatorze. Nie lubi technologii, więc:
- pisz krótko, prostym językiem, po polsku, zwracaj się per "Pan",
- zadawaj JEDNO pytanie naraz, maksymalnie dwa krótkie zdania,
- każdą informację, którą poda, od razu nanoś na ofertę narzędziem aktualizuj_oferte (nawet częściowo),
- nie wymyślaj cen, rabatów ani parametrów technicznych; używaj tylko tego, co podał lub co jest już w ofercie,
- kwoty podawane słownie zamieniaj na liczby (np. "88 tysięcy" = 88000), domyślna waluta EUR netto.

Kolejność zbierania danych (pomijaj to, co już jest w ofercie):
1. dla jakiej firmy i osoby, ewentualnie e-mail lub telefon klienta,
2. który model (z katalogu),
3. cena bazowa netto,
4. dodatkowe wyposażenie i jego ceny,
5. rabat, termin dostawy, warunki płatności,
Na koniec krótko podsumuj ofertę i napisz, że może kliknąć "Pobierz PDF" albo "Wyślij mailem".
Gdy prosi o zmianę czegokolwiek, zmień to i potwierdź jednym zdaniem.`;

const TOOL = {
  name: "aktualizuj_oferte",
  description: "Nanosi zmiany na ofertę widoczną w generatorze. Podawaj tylko pola, które się zmieniają.",
  input_schema: {
    type: "object",
    properties: {
      model: { type: "string", description: "Klucz modelu z katalogu. Zmiana modelu podmienia opis, specyfikację i wyposażenie." },
      client: { type: "object", properties: {
        company: { type: "string" }, person: { type: "string" }, nip: { type: "string" },
        address: { type: "string" }, contact: { type: "string", description: "e-mail i/lub telefon" } } },
      product: { type: "object", properties: {
        name: { type: "string" }, year: { type: "string" }, type: { type: "string" },
        capacity: { type: "string" }, summary: { type: "string" } } },
      price: { type: "object", properties: {
        base: { type: "number", description: "cena bazowa netto" },
        discount: { type: "number", description: "rabat netto jako kwota" } } },
      offer: { type: "object", properties: {
        currency: { type: "string", enum: ["EUR", "PLN"] }, vat: { type: "number" },
        from: { type: "boolean", description: "czy pokazywać 'cena od'" },
        valid: { type: "string", description: "data ważności RRRR-MM-DD" } } },
      terms: { type: "object", properties: {
        delivery: { type: "string" }, payment: { type: "string" }, warranty: { type: "string" },
        financing: { type: "string" }, pickup: { type: "string" }, notes: { type: "string" } } },
      options: { type: "array", description: "Wyposażenie dodatkowe do włączenia lub dodania. Istniejąca pozycja o tej samej nazwie jest aktualizowana.",
        items: { type: "object", required: ["name"], properties: {
          name: { type: "string" }, price: { type: "number", description: "cena netto, 0 = w cenie" },
          group: { type: "string" }, on: { type: "boolean", description: "false = usuń z oferty" } } } },
      standard_add: { type: "array", items: { type: "string" }, description: "pozycje wyposażenia standardowego do dodania" }
    }
  }
};

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (req.method !== "POST") return json({ error: "Tylko POST" }, 405, origin);
    if (!ALLOWED.includes(origin)) return json({ error: "Niedozwolone źródło" }, 403, origin);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Zły format" }, 400, origin); }
    if (!env.ACCESS_PIN || body.pin !== env.ACCESS_PIN) return json({ error: "pin" }, 401, origin);

    const messages = (body.messages || []).slice(-30)
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Brak pytania" }, 400, origin);

    const context = `Dzisiejsza data: ${new Date().toISOString().slice(0, 10)}.
Katalog modeli (klucz: opis): ${JSON.stringify(body.catalog || {})}
Aktualny stan oferty: ${JSON.stringify(body.state || {}).slice(0, 12000)}`;

    const updates = [], texts = [];
    for (let round = 0; round < 3; round++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM + "\n\n" + context, tools: [TOOL], messages })
      });
      if (!r.ok) return json({ error: "api", status: r.status }, 502, origin);
      const data = await r.json();
      const t = data.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      if (t) texts.push(t);
      const calls = data.content.filter(c => c.type === "tool_use");
      calls.forEach(c => updates.push(c.input));
      if (data.stop_reason !== "tool_use" || !calls.length) break;
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: calls.map(c => ({ type: "tool_result", tool_use_id: c.id, content: "Zmiany naniesione na ofertę." })) });
    }
    return json({ text: texts.join("\n\n"), updates }, 200, origin);
  }
};
