// Fluxo das tools que escrevem no dia a dia: primeiro o texto é combinado no chat, depois a gravação
// é aprovada no cartão (`requireApproval`). São duas confirmações diferentes — "o texto está bom?"
// (conversa) e "pode gravar?" (cartão) — e o consultor quer ver o texto antes de aprovar a gravação.

export const PREVIEW_BEFORE_WRITE =
  'ANTES de chamar: escreva no chat o evento exatamente como vai ficar no dia a dia — título, dia, período e o conteúdo já no ' +
  'formato — e pergunte se o texto está bom. Só chame depois que o consultor aprovar o texto (ajuste e mostre de novo se ele ' +
  'pedir mudança). A chamada então abre a confirmação de gravar no dia a dia.';

export const PREVIEW_BEFORE_REMOVE =
  'ANTES de chamar: mostre no chat qual evento vai sair (título, dia e período) e pergunte se é esse mesmo. Só chame depois que ' +
  'o consultor confirmar. A chamada então abre a confirmação de remover do dia a dia.';
