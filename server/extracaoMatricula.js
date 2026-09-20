// Núcleo de extração compartilhado com o Integração.
const SYSTEM_INSTRUCTIONS = `
Voce e um especialista tecnico em leitura de documentos fundiarios brasileiros
(matriculas imobiliarias, memoriais descritivos, escrituras) para a empresa
Integral Solucoes em Engenharia.

Sua UNICA tarefa e IDENTIFICAR e EXTRAIR informacoes literalmente presentes no
documento, estruturando-as atraves da ferramenta "extrair_dados_matricula".

REGRAS OBRIGATORIAS E INEGOCIAVEIS (regra fundamental contra alucinacao):
- Nunca invente coordenadas.
- Nunca complete digitos ilegiveis ou parcialmente visiveis.
- Nunca invente numero de matricula.
- Nunca invente datum.
- Nunca invente zona UTM.
- Nunca invente EPSG.
- Nunca invente confrontante.
- Nunca presuma zona UTM ou datum quando eles nao estiverem explicitos no texto.
- Quando uma informacao nao puder ser determinada com seguranca, retorne null
  nesse campo e descreva o problema em "alertas".
- Preserve RIGOROSAMENTE a ordem em que os vertices aparecem na descricao
  perimetral do documento. NUNCA reordene vertices por latitude, longitude,
  numero ou proximidade.
- Para cada vertice, preencha "texto_origem" com o trecho literal do
  documento de onde a coordenada/distancia/azimute foi retirada, para
  permitir auditoria humana.
- Para cada vertice, estime "confianca" entre 0 e 1 refletindo o quanto o
  texto original era claro e legivel (nunca use um valor fixo/generico).
- Coordenadas podem aparecer como: decimal (-26.337412), GMS
  (26°20'14.221"S), ou UTM (E/N ou X/Y).
- Para latitude/longitude, SEMPRE transcreva o texto EXATAMENTE como impresso
  no documento (nos campos latitude_texto/longitude_texto) - incluindo graus,
  minutos, segundos, virgula/ponto decimal e hemisferio, exatamente como
  aparecem. NUNCA converta graus/minutos/segundos para grau decimal you
  mesmo - essa conversao matematica (graus + minutos/60 + segundos/3600) e
  feita por outro modulo do sistema, de forma deterministica e exata. Se
  voce fizer essa conta, ela pode sair errada e distorcer toda a geometria
  calculada depois. Apenas copie o texto.
- Para UTM, preencha easting/northing com os numeros exatamente como
  impressos (isso e transcricao, nao calculo).
- Voce NAO deve calcular area, perimetro, converter sistemas de coordenadas
  ou construir geometria. Isso e feito por outro modulo do sistema.
- Preencha "situacao_matricula": procure no texto por indicacoes de que ESTA
  matricula foi cancelada, encerrada, unificada ou transportada para outra
  (ex: "matricula encerrada", "transporte de matricula", "unificada na
  matricula X", "cancelada por forca de..."). Se encontrar, defina ativa=false
  e preencha substituida_por com o numero da matricula nova, quando citado.
  Se nao houver nenhuma indicacao disso, defina ativa=true.
- Preencha "matriculas_citadas" com TODOS os numeros de matricula mencionados
  no texto que sejam DIFERENTES da matricula sendo analisada (registro
  anterior, confrontantes que citam numero de matricula, substituicoes,
  matriculas de origem/desmembramento, etc). Nao repita numeros.
- Preencha "historico_registro" com cada ato de registro/averbacao numerado
  que aparecer no documento (R.1, R.2, AV.1, AV.2, etc.), na ordem em que
  aparecem. IMPORTANTE: mesmo o ato de ABERTURA da matricula (ex: R.1) deve
  ser incluido se ele proprio ja representa uma transferencia de posse ou
  propriedade (ex: usucapiao, compra e venda, doacao, heranca/inventario,
  extincao de condominio) - so retorne lista vazia se a matricula realmente
  nao tiver NENHUM ato que envolva posse/propriedade/valor alem de dados
  cadastrais. Preencha "de" (quem transferiu/vendeu, se aplicavel) e "para"
  (quem recebeu/adquiriu, se aplicavel) com os nomes exatos das partes
  envolvidas nesse ato especifico - null se o ato nao muda a titularidade
  (ex: mera retificacao de area). Preencha "valor" com o valor monetario do
  ato quando o documento mencionar (ex: "Valor do imovel: R$ 10.000,00"),
  null se nao houver. Use "descricao" para contexto adicional relevante que
  nao caiba em de/para/valor (ex: motivo, protocolo, mandado judicial).
- CRITICO - NUNCA crie um vertice extra apenas para representar o fechamento
  do poligono. Quando o memorial diz algo como "...ate encontrar o marco
  inicial M1, ponto de partida desta descricao" ou "fechando o poligono no
  ponto inicial", isso significa que o ULTIMO segmento (distancia/azimute)
  liga o ultimo vertice de volta ao PRIMEIRO vertice ja listado - NAO crie um
  vertice novo (nunca use um id como "M1_fechamento", "fechamento",
  "retorno" ou repita o mesmo id com sufixo). O poligono e sempre fechado
  implicitamente pelo sistema (ultimo vertice conecta ao primeiro); a lista
  de vertices deve conter cada ponto fisico distinto exatamente uma vez, na
  ordem do memorial, terminando no ULTIMO vertice antes de retornar ao
  primeiro (o segmento de retorno fica no campo distancia/azimute do
  ULTIMO vertice da lista, apontando implicitamente de volta ao primeiro).
- CRITICO - antes de finalizar a resposta, releia o memorial descritivo e
  CONTE quantos marcos/pontos/vertices distintos ele realmente menciona
  (ex: M1, M2, M3, M4 = 4 vertices). O array "vertices" da sua resposta deve
  ter EXATAMENTE essa quantidade, nem a mais (vertice de fechamento
  duplicado) nem a menos (vertice pulado). Documentos identicos analisados
  novamente devem produzir o mesmo numero de vertices - isso e uma extracao
  factual, nao uma interpretacao variavel.
- Preencha "sugestao_geografica" SOMENTE se sistema_coordenadas.tipo for UTM e
  zona ou datum estiverem null. Isto e uma EXCECAO deliberada a regra de
  "nunca calcular/inferir": aqui voce pode usar seu conhecimento GERAL de
  geografia (nao o texto do documento) para sugerir a zona UTM e o datum mais
  provaveis, dado o municipio/estado do imovel. Esta sugestao e sempre exibida
  ao usuario como "sugestao da IA, nao extraida do documento" e nunca aplicada
  automaticamente - o usuario decide se confirma. Se nao tiver confianca
  razoavel, deixe os campos null.
- Preencha "sistema_coordenadas.meridiano_central" quando o documento citar o
  Meridiano Central do levantamento (comum em memoriais mais antigos, em vez
  de declarar "Fuso/Zona X" diretamente) - ex: "referentes ao Meridiano
  Central 51 WGr". Transcreva o valor literal; a conversao para zona UTM e
  feita por outro modulo do sistema.
- Se o documento nao for um dos tipos esperados, ainda assim extraia o que
  for aplicavel e defina tipo_documento como "OUTRO".
- Sua resposta deve ser SOMENTE a chamada da ferramenta "extrair_dados_matricula"
  com os dados extraidos - nao responda com texto adicional.
`.trim();

// Mesma estrutura de dados usada antes (schema JSON), agora como
// input_schema de uma tool da Anthropic em vez de response_format da OpenAI.
const EXTRACTION_TOOL = {
  name: "extrair_dados_matricula",
  description:
    "Registra os dados IDENTIFICADOS e EXTRAIDOS do documento fundiario (matricula, memorial descritivo, etc). " +
    "Preencha apenas o que estiver literalmente presente no documento; use null quando nao houver certeza.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "tipo_documento",
      "matricula",
      "proprietario",
      "imovel",
      "sistema_coordenadas",
      "situacao_matricula",
      "matriculas_citadas",
      "sugestao_geografica",
      "historico_registro",
      "vertices",
      "confrontantes",
      "alertas"
    ],
    properties: {
      tipo_documento: {
        type: "string",
        enum: [
          "MATRICULA_IMOVEL",
          "MEMORIAL_DESCRITIVO",
          "ESCRITURA",
          "CONTRATO",
          "PLANTA",
          "OUTRO"
        ]
      },
      matricula: {
        type: "object",
        additionalProperties: false,
        required: ["numero", "cartorio", "comarca", "municipio", "estado"],
        properties: {
          numero: { type: ["string", "null"] },
          cartorio: { type: ["string", "null"] },
          comarca: { type: ["string", "null"] },
          municipio: { type: ["string", "null"] },
          estado: { type: ["string", "null"], description: "Sigla UF, ex: SC" }
        }
      },
      proprietario: {
        type: "object",
        additionalProperties: false,
        required: ["nome", "cpf", "cnpj"],
        properties: {
          nome: { type: ["string", "null"] },
          cpf: { type: ["string", "null"] },
          cnpj: { type: ["string", "null"] }
        }
      },
      imovel: {
        type: "object",
        additionalProperties: false,
        required: ["descricao", "endereco", "lote", "quadra", "area_registral", "unidade_area"],
        properties: {
          descricao: { type: ["string", "null"] },
          endereco: { type: ["string", "null"] },
          lote: { type: ["string", "null"] },
          quadra: { type: ["string", "null"] },
          area_registral: { type: ["number", "null"] },
          unidade_area: { type: ["string", "null"], description: "ex: m2, ha" }
        }
      },
      sistema_coordenadas: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "datum", "epsg", "zona", "hemisferio", "meridiano_central"],
        properties: {
          tipo: {
            type: ["string", "null"],
            description: "UTM, GEOGRAFICA (lat/long) ou null se nao identificado"
          },
          datum: { type: ["string", "null"], description: "ex: SIRGAS2000, SAD69, WGS84" },
          epsg: { type: ["string", "null"] },
          zona: { type: ["number", "null"] },
          hemisferio: { type: ["string", "null"], description: "N ou S" },
          meridiano_central: {
            type: ["string", "null"],
            description:
              "Valor do Meridiano Central citado no documento (comum em levantamentos mais antigos, em graus, geralmente oeste de Greenwich), quando o documento usa essa forma em vez de declarar diretamente a zona/fuso UTM. Ex: '51', '51 WGr', '51°W'. Transcreva literalmente; nao converta para zona."
          }
        }
      },
      situacao_matricula: {
        type: "object",
        additionalProperties: false,
        required: ["ativa", "substituida_por", "texto_origem"],
        description:
          "Indica se o texto do documento menciona que ESTA matricula foi cancelada, encerrada, unificada ou transportada para outra matricula.",
        properties: {
          ativa: {
            type: ["boolean", "null"],
            description:
              "false se o documento indica que esta matricula foi cancelada/encerrada/transportada/unificada em outra; true se nao ha essa indicacao; null se nao for possivel determinar."
          },
          substituida_por: {
            type: ["string", "null"],
            description: "Numero da matricula que substituiu/absorveu esta, se mencionado no texto (ex: '24.200')."
          },
          texto_origem: {
            type: ["string", "null"],
            description: "Trecho literal do documento que indica a substituicao/cancelamento, se houver."
          }
        }
      },
      matriculas_citadas: {
        type: "array",
        description:
          "TODO numero de matricula mencionado no documento que NAO seja o numero da propria matricula sendo analisada - " +
          "ex: em 'registro anterior', em confrontantes ('confrontando com o imovel da matricula 24.118'), em substituicoes, etc. " +
          "Liste cada numero apenas uma vez.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["numero", "contexto"],
          properties: {
            numero: { type: "string", description: "ex: '24.118'" },
            contexto: {
              type: ["string", "null"],
              description: "breve descricao de onde/por que foi citada, ex: 'confrontante ao norte' ou 'registro anterior'"
            }
          }
        }
      },
      sugestao_geografica: {
        type: "object",
        additionalProperties: false,
        required: ["zona_utm_sugerida", "datum_sugerido", "justificativa"],
        description:
          "ATENCAO: isto NAO e extracao do documento. Preencha apenas se sistema_coordenadas.tipo for UTM e " +
          "sistema_coordenadas.zona e/ou datum estiverem null porque o documento nao os informa. Com base no seu " +
          "CONHECIMENTO GERAL de geografia do Brasil (nao no texto do documento), sugira a zona UTM e o datum mais " +
          "provaveis para o municipio/estado do imovel identificado em matricula.municipio/matricula.estado. " +
          "So preencha se tiver confianca razoavel; caso contrario deixe os campos null. Esta sugestao sera exibida " +
          "na interface claramente rotulada como 'sugestao da IA, nao extraida do documento', pre-preenchendo um " +
          "formulario que o usuario deve revisar e confirmar manualmente antes de qualquer uso - nunca e aplicada automaticamente.",
        properties: {
          zona_utm_sugerida: { type: ["number", "null"] },
          datum_sugerido: {
            type: ["string", "null"],
            description: "ex: SIRGAS2000 (padrao oficial desde 2005), SAD69, Corrego Alegre (mais comuns em levantamentos antigos)"
          },
          justificativa: {
            type: ["string", "null"],
            description: "breve explicacao, ex: 'Municipio de Anita Garibaldi/SC esta inteiramente na zona UTM 22; SIRGAS2000 e o datum oficial brasileiro desde 2005'"
          }
        }
      },
      historico_registro: {
        type: "array",
        description:
          "Historico cronologico de atos de registro/averbacao da matricula (ex: R.1, R.2, AV.1, AV.2, Usucapiao, " +
          "transporte, transferencia de posse/propriedade, hipoteca, penhora, etc.), na ordem em que aparecem no " +
          "documento. Inclua apenas atos que tenham numero/ato identificavel no texto (ex: 'R.1-14.932', " +
          "'AV.2-16.315'). Se o documento nao tiver nenhum ato alem da abertura da matricula, retorne lista vazia.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ato", "data", "tipo", "de", "para", "valor", "descricao"],
          properties: {
            ato: { type: "string", description: "Identificador do ato como aparece no documento, ex: 'R.1-14.932' ou 'AV.2-16.315'" },
            data: { type: ["string", "null"], description: "Data do ato, como escrita no documento" },
            tipo: {
              type: ["string", "null"],
              description: "Categoria breve do ato, ex: 'Registro', 'Averbacao', 'Usucapiao', 'Transferencia', 'Hipoteca', 'Penhora', 'Retificacao'"
            },
            de: {
              type: ["string", "null"],
              description: "Nome de quem transferiu/vendeu/cedeu (proprietario anterior), quando o ato envolver transferencia de posse/propriedade. Null se nao aplicavel (ex: hipoteca nao muda o dono)."
            },
            para: {
              type: ["string", "null"],
              description: "Nome de quem recebeu/adquiriu (novo proprietario ou beneficiario), quando aplicavel. Null se nao aplicavel."
            },
            valor: {
              type: ["string", "null"],
              description: "Valor monetario do ato, como escrito no documento (com moeda), ex: 'R$ 10.000,00'. Null se o documento nao mencionar valor para este ato."
            },
            descricao: {
              type: "string",
              description: "Resumo breve (1-2 frases) do que o ato registra, alem do de/para/valor ja capturados nos campos proprios - parafraseado, nao copiado literalmente do documento"
            }
          }
        }
      },
      vertices: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "latitude_texto",
            "longitude_texto",
            "easting",
            "northing",
            "distancia_para_proximo",
            "azimute_para_proximo",
            "rumo_para_proximo",
            "confrontante_para_proximo",
            "texto_origem",
            "confianca"
          ],
          properties: {
            id: { type: "string", description: "ex: V01" },
            latitude_texto: {
              type: ["string", "null"],
              description:
                "Latitude TRANSCRITA EXATAMENTE como impressa no documento (graus/minutos/segundos ou decimal, com o hemisferio). Ex: \"27\u00b002'41,8924\\\" S\". NUNCA converta para grau decimal - isso e feito por outro modulo."
            },
            longitude_texto: {
              type: ["string", "null"],
              description: "Mesma regra da latitude, para a longitude. Ex: \"49\u00b034'08,4291\\\" O\"."
            },
            easting: { type: ["number", "null"] },
            northing: { type: ["number", "null"] },
            distancia_para_proximo: { type: ["number", "null"], description: "metros, ate o proximo vertice" },
            azimute_para_proximo: { type: ["string", "null"] },
            rumo_para_proximo: { type: ["string", "null"] },
            confrontante_para_proximo: { type: ["string", "null"] },
            texto_origem: { type: ["string", "null"] },
            confianca: { type: "number" }
          }
        }
      },
      confrontantes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["vertice_inicial", "vertice_final", "nome", "tipo", "distancia", "azimute"],
          properties: {
            vertice_inicial: { type: ["string", "null"] },
            vertice_final: { type: ["string", "null"] },
            nome: { type: ["string", "null"] },
            tipo: {
              type: ["string", "null"],
              description: "PARTICULAR, RUA, RODOVIA, RIO, CORREGO, AREA_PUBLICA ou OUTRO"
            },
            distancia: { type: ["number", "null"] },
            azimute: { type: ["string", "null"] }
          }
        }
      },
      alertas: {
        type: "array",
        description: "Mensagens sobre informacoes ausentes, ambiguas ou nao determinaveis com seguranca.",
        items: { type: "string" }
      }
    }
  }
};


module.exports={SYSTEM_INSTRUCTIONS,EXTRACTION_TOOL};
