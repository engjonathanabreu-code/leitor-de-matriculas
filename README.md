# INTEGRAL GEO MATRÍCULA

Aplicação web para leitura de matrículas imobiliárias e memoriais descritivos
com IA (identificação/extração) + geoprocessamento determinístico (validação,
poligonal, área, perímetro). Desenvolvida para a **Integral Soluções em
Engenharia**.

> **Importante — divisão de responsabilidades**
> A IA (OpenAI) **só identifica e extrai** o que está escrito no documento.
> **Nenhuma linha de código de geoprocessamento (conversão de coordenadas,
> construção da poligonal, área, perímetro, validações) usa IA.** Essa parte é
> feita inteiramente em JavaScript determinístico, com Turf.js e Proj4js, no
> navegador (`lib/coordinates.js` e `lib/geometry.js`).

---

## 1. Estrutura do projeto
