# Como adicionar fotos nos itens

## Melhor jeito

O jeito mais simples e seguro para este app e:

1. salvar a foto dentro da pasta do projeto
2. usar o campo `Foto do item` no painel administrativo
3. informar o caminho da imagem

## Pasta das fotos

Coloque as imagens aqui:

- [assets/items](C:\Users\jr\Desktop\app%20delivery\assets\items)

Exemplos:

- [assets/items/x-salada.jpg](C:\Users\jr\Desktop\app%20delivery\assets\items\x-salada.jpg)
- [assets/items/pizza-calabresa.jpg](C:\Users\jr\Desktop\app%20delivery\assets\items\pizza-calabresa.jpg)

## Passo a passo

### 1. Salve a imagem na pasta

Exemplo:

- `C:\Users\jr\Desktop\app delivery\assets\items\x-salada.jpg`

### 2. Abra o painel administrativo

Entre na aba:

- `Cardapio`

### 3. Abra ou crie o item

Preencha normalmente:

- nome
- preco
- categoria
- descricao

### 4. Preencha o campo `Foto do item`

Use o caminho relativo da imagem:

```text
./assets/items/x-salada.jpg
```

### 5. Clique em `Salvar item`

Pronto. A foto deve aparecer:

- na tela da loja
- na pagina do item

## Regras importantes

- use nomes simples nas imagens
- prefira letras minusculas
- use `-` no lugar de espacos

Exemplo bom:

```text
x-salada.jpg
```

Exemplo ruim:

```text
X Salada Foto Final 01.jpg
```

## Formatos recomendados

- `.jpg`
- `.png`
- `.webp`

## Exemplo pronto

Se a imagem estiver aqui:

```text
assets/items/pastel-carne.jpg
```

No painel voce coloca:

```text
./assets/items/pastel-carne.jpg
```
