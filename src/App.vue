<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc, updateDoc, getDocs, where } from 'firebase/firestore'
import { signInWithRedirect, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth'
import { db, auth } from './firebase' 

import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js'
import { Doughnut } from 'vue-chartjs'
import emailjs from '@emailjs/browser'
import confetti from 'canvas-confetti' 
// NOVO: Importações para exportação em PDF
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable' // <-- Agora importamos a função diretamente

ChartJS.register(ArcElement, Tooltip, Legend)

// 0. ESTADO DE AUTENTICAÇÃO E FAMÍLIA
const usuarioLogado = ref(null)
const carregandoAuth = ref(true)
const familiaAtual = ref(null) 

let unsubTransacoes = null;
let unsubCategorias = null;
let unsubContas = null;
let unsubMetas = null;

const extrairNome = (email) => {
  if(!email) return '';
  const parte = email.split('@')[0];
  return parte.charAt(0).toUpperCase() + parte.slice(1);
};

const loginComGoogle = async () => {
  const provider = new GoogleAuthProvider();
  try { await signInWithRedirect(auth, provider); } 
  catch (error) { alert("Falha ao fazer login com o Google."); }
}

const fazerLogout = async () => {
  if(confirm("Tem certeza que deseja sair?")) {
    await signOut(auth);
    window.location.reload(); 
  }
}

// 1. FUNÇÕES DE GESTÃO DA FAMÍLIA E CONVITE
const criarFamilia = async () => {
  try {
    const docRef = await addDoc(collection(db, "familias"), {
      nome: `Família de ${usuarioLogado.value.displayName.split(' ')[0]}`,
      membros: [usuarioLogado.value.email.toLowerCase()]
    });
    familiaAtual.value = { id: docRef.id, nome: `Família de ${usuarioLogado.value.displayName.split(' ')[0]}`, membros: [usuarioLogado.value.email.toLowerCase()] };
    iniciarListenersDaFamilia(docRef.id);
    telaAtual.value = 'dashboard';
  } catch (e) {
    alert("Erro ao criar ambiente.");
  }
}

const emailConvite = ref('');
const statusEnvio = ref(''); 

const convidarMembro = async () => {
  if (!emailConvite.value || !emailConvite.value.includes('@')) return;
  const emailFormatado = emailConvite.value.toLowerCase().trim();
  if (familiaAtual.value.membros.includes(emailFormatado)) { alert("Este e-mail já faz parte da família!"); return; }
  
  statusEnvio.value = 'Enviando convite...';
  try {
    const novosMembros = [...familiaAtual.value.membros, emailFormatado];
    await updateDoc(doc(db, "familias", familiaAtual.value.id), { membros: novosMembros });
    familiaAtual.value.membros = novosMembros;
    
    const linkApp = window.location.origin; 
    await emailjs.send('SEU_SERVICE_ID', 'SEU_TEMPLATE_ID', { to_email: emailFormatado, link_app: linkApp }, 'SUA_PUBLIC_KEY');
    
    emailConvite.value = ''; statusEnvio.value = ''; alert(`Convite enviado com sucesso para ${emailFormatado}!`);
  } catch (e) { 
    console.error("Erro ao convidar: ", e); statusEnvio.value = '';
    alert("O membro foi adicionado, mas houve um erro ao enviar o e-mail automático."); 
  }
}

const removerMembro = async (emailParaRemover) => {
  if (emailParaRemover === usuarioLogado.value.email) { alert("Você não pode remover a si mesmo por aqui."); return; }
  if(confirm(`Remover o acesso de ${emailParaRemover}?`)) {
    const novosMembros = familiaAtual.value.membros.filter(e => e !== emailParaRemover);
    await updateDoc(doc(db, "familias", familiaAtual.value.id), { membros: novosMembros });
    familiaAtual.value.membros = novosMembros;
  }
}

const iniciarListenersDaFamilia = (familiaId) => {
  const pastaFamilia = doc(db, "familias", familiaId);
  unsubTransacoes = onSnapshot(query(collection(pastaFamilia, "transacoes"), orderBy("data", "desc")), (qs) => {
    const listaT = []; qs.forEach((d) => listaT.push({ id: d.id, ...d.data() })); transacoes.value = listaT;
  });
  unsubCategorias = onSnapshot(query(collection(pastaFamilia, "categorias"), orderBy("nome", "asc")), (qs) => {
    const listaC = []; qs.forEach((d) => listaC.push({ id: d.id, nome: d.data().nome, subcategorias: d.data().subcategorias || [], limiteMensal: d.data().limiteMensal || 0 })); categoriasDisponiveis.value = listaC;
  });
  unsubContas = onSnapshot(query(collection(pastaFamilia, "contas"), orderBy("nome", "asc")), (qs) => {
    const listaContas = []; qs.forEach((d) => listaContas.push({ id: d.id, nome: d.data().nome, tipo: d.data().tipo })); contasDisponiveis.value = listaContas;
  });
  unsubMetas = onSnapshot(query(collection(pastaFamilia, "metas"), orderBy("nome", "asc")), (qs) => {
    const listaM = []; qs.forEach((d) => listaM.push({ id: d.id, ...d.data() })); metas.value = listaM;
  });
}

// 2. ESTADO DA INTERFACE E MENUS
const telaAtual = ref('dashboard') 
const temaEscuro = ref(false)
const alternarTema = () => temaEscuro.value = !temaEscuro.value;

const mostrarFormulario = ref(false)
const alternarFormulario = () => mostrarFormulario.value = !mostrarFormulario.value;
const menuLancamentosAberto = ref(true)

// 3. ESTADO DO FILTRO DE MÊS
const mesAtualYMD = new Date().toISOString().slice(0, 7);
const mesFiltro = ref(mesAtualYMD);

const alterarMes = (delta) => {
  let [ano, mes] = mesFiltro.value.split('-').map(Number);
  mes += delta;
  if (mes > 12) { mes = 1; ano += 1; }
  if (mes < 1) { mes = 12; ano -= 1; }
  mesFiltro.value = `${ano}-${String(mes).padStart(2, '0')}`;
};

const mesFormatado = computed(() => {
  if (!mesFiltro.value) return '';
  const [ano, mes] = mesFiltro.value.split('-');
  const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return `${meses[parseInt(mes) - 1]} ${ano}`;
});

const getColecao = (nomeColecao) => collection(doc(db, "familias", familiaAtual.value.id), nomeColecao);
const getDocRef = (nomeColecao, id) => doc(db, "familias", familiaAtual.value.id, nomeColecao, id);

// 4. ESTADO DAS METAS E ATALHO DE APORTE
const metas = ref([])
const novaMetaNome = ref('')
const novaMetaObjetivo = ref('')
const novaMetaAtual = ref('')

const metasPendentes = computed(() => {
  return metas.value.filter(m => m.valorAtual < m.valorObjetivo);
});

const adicionarMeta = async () => {
  if (!novaMetaNome.value || !novaMetaObjetivo.value) return;
  const objetivo = parseFloat(novaMetaObjetivo.value);
  if (objetivo <= 0) { alert("O valor objetivo precisa ser maior que zero."); return; }
  try {
    await addDoc(getColecao("metas"), { nome: novaMetaNome.value.trim(), valorObjetivo: objetivo, valorAtual: parseFloat(novaMetaAtual.value || 0) });
    novaMetaNome.value = ''; novaMetaObjetivo.value = ''; novaMetaAtual.value = '';
  } catch(e) { alert("Erro ao criar meta."); }
}

const removerMeta = async (id) => {
  if(confirm("Excluir esta meta? O progresso será apagado.")) {
    await deleteDoc(getDocRef("metas", id));
  }
}

const iniciarAporte = (meta) => {
  telaAtual.value = 'lancamentos';
  mostrarFormulario.value = true;
  tipo.value = 'meta';
  metaSelecionada.value = meta.id;
  responsavel.value = usuarioLogado.value.email.toLowerCase(); 
  descricao.value = `Aporte: ${meta.nome}`;
}

// 5. ESTADO DAS CONTAS, CARTÕES E CATEGORIAS 
const contasDisponiveis = ref([])
const novaContaNome = ref('')
const novaContaTipo = ref('Conta Bancária')
const adicionarConta = async () => {
  if (!novaContaNome.value) return;
  const existe = contasDisponiveis.value.find(c => c.nome.toLowerCase() === novaContaNome.value.toLowerCase());
  if (!existe) {
    try {
      await addDoc(getColecao("contas"), { nome: novaContaNome.value.trim(), tipo: novaContaTipo.value });
      novaContaNome.value = ''; 
    } catch (e) { alert("Erro ao adicionar conta."); }
  } else { alert("Conta/cartão já existe."); }
}
const removerConta = async (id) => { await deleteDoc(getDocRef("contas", id)); }
const editarConta = async (conta) => {
  const novoNome = prompt("Novo nome:", conta.nome);
  if (!novoNome || novoNome.trim() === "" || novoNome === conta.nome) return;
  try {
    await updateDoc(getDocRef("contas", conta.id), { nome: novoNome.trim() });
    const q = query(getColecao("transacoes"), where("conta", "==", conta.nome));
    const qs = await getDocs(q);
    qs.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { conta: novoNome.trim() }));
    const qDestino = query(getColecao("transacoes"), where("contaDestino", "==", conta.nome));
    const qsDestino = await getDocs(qDestino);
    qsDestino.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { contaDestino: novoNome.trim() }));
  } catch (e) { alert("Erro ao renomear."); }
}

const categoriasDisponiveis = ref([]) 
const novaCategoria = ref('')
const inputsSubcategoria = ref({}) 
const adicionarCategoria = async () => {
  if (!novaCategoria.value) return;
  const existe = categoriasDisponiveis.value.find(c => c.nome.toLowerCase() === novaCategoria.value.toLowerCase());
  if (!existe) {
    try {
      await addDoc(getColecao("categorias"), { nome: novaCategoria.value.trim(), subcategorias: [], limiteMensal: 0 });
      novaCategoria.value = ''; 
    } catch (e) { alert("Erro ao adicionar."); }
  } else { alert("Categoria já existe."); }
}
const removerCategoria = async (id) => { await deleteDoc(getDocRef("categorias", id)); }

const definirLimite = async (categoria) => {
  const limiteStr = prompt(`Defina o limite mensal para "${categoria.nome}" (R$):\nDeixe em branco ou 0 para remover.`, categoria.limiteMensal || '');
  if (limiteStr === null) return; 
  const limiteNum = parseFloat(limiteStr.replace(',', '.')) || 0;
  try { await updateDoc(getDocRef("categorias", categoria.id), { limiteMensal: limiteNum }); } 
  catch (e) { alert("Erro ao salvar limite."); }
}

const editarCategoria = async (categoria) => {
  const novoNome = prompt("Novo nome:", categoria.nome);
  if (!novoNome || novoNome.trim() === "" || novoNome === categoria.nome) return;
  try {
    await updateDoc(getDocRef("categorias", categoria.id), { nome: novoNome.trim() });
    const q = query(getColecao("transacoes"), where("categoria", "==", categoria.nome));
    const qs = await getDocs(q);
    qs.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { categoria: novoNome.trim() }));
  } catch (e) { alert("Erro ao renomear."); }
}
const adicionarSubcategoria = async (categoria) => {
  const novaSub = inputsSubcategoria.value[categoria.id];
  if (!novaSub || categoria.subcategorias.includes(novaSub)) return;
  try {
    await updateDoc(getDocRef("categorias", categoria.id), { subcategorias: [...categoria.subcategorias, novaSub] });
    inputsSubcategoria.value[categoria.id] = ''; 
  } catch (e) { alert("Erro."); }
}
const removerSubcategoria = async (categoria, subRemover) => {
  await updateDoc(getDocRef("categorias", categoria.id), { subcategorias: categoria.subcategorias.filter(s => s !== subRemover) });
}

// 6. ESTADO DOS LANÇAMENTOS E UPLOAD
const hoje = new Date().toISOString().slice(0, 10);
const tipo = ref('despesa') 
const dataLancamento = ref(hoje)
const descricao = ref('')
const valor = ref('')
const categoriaSelecionada = ref('') 
const subcategoriaSelecionada = ref('') 
const responsavel = ref('') 
const beneficiario = ref('') 
const contaSelecionada = ref('') 
const contaDestinoSelecionada = ref('') 
const metaSelecionada = ref('') 
const transacoes = ref([])

const arquivoComprovante = ref(null)
const uploadProgresso = ref(false)

const isParcelado = ref(false)
const numeroParcelas = ref(2)
const dataPrimeiraParcela = ref(hoje)

const subcategoriasDropdown = computed(() => {
  const cat = categoriasDisponiveis.value.find(c => c.nome === categoriaSelecionada.value);
  return cat ? cat.subcategorias : [];
});

watch(categoriaSelecionada, () => {
  if (subcategoriasDropdown.value.length > 0) subcategoriaSelecionada.value = subcategoriasDropdown.value[0]; 
  else subcategoriaSelecionada.value = ''; 
});

watch(categoriasDisponiveis, (novaLista) => {
  if (novaLista.length > 0 && (!categoriaSelecionada.value || !novaLista.find(c => c.nome === categoriaSelecionada.value))) {
    categoriaSelecionada.value = novaLista[0].nome;
  }
});

watch(contasDisponiveis, (novaLista) => {
  if (novaLista.length > 0) {
    if(!contaSelecionada.value || !novaLista.find(c => c.nome === contaSelecionada.value)) contaSelecionada.value = novaLista[0].nome;
    if(!contaDestinoSelecionada.value || !novaLista.find(c => c.nome === contaDestinoSelecionada.value)) contaDestinoSelecionada.value = novaLista[0].nome;
  }
});

watch(tipo, (novoTipo) => {
  if (novoTipo === 'meta') isParcelado.value = false;
})

const calcularDataFutura = (dataBase, meses) => {
  const [a, m, d] = dataBase.split('-');
  const dt = new Date(a, m - 1, d);
  const diaOrig = dt.getDate();
  dt.setMonth(dt.getMonth() + meses);
  if (dt.getDate() !== diaOrig) dt.setDate(0); 
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const soltarConfetes = () => {
  confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#10b981', '#3b82f6', '#f59e0b'], zIndex: 9999 });
};

const selecionarArquivo = (event) => {
  arquivoComprovante.value = event.target.files[0];
};

const adicionarTransacao = async () => {
  if (!descricao.value || !valor.value || !dataLancamento.value || !contaSelecionada.value || !responsavel.value) {
    alert("Preencha todos os campos obrigatórios."); return;
  }
  
  if (tipo.value === 'transferencia') {
    if (!beneficiario.value) { alert("Informe o destinatário."); return; }
    if (!contaDestinoSelecionada.value) { alert("Informe a conta de destino."); return; }
  }
  if (tipo.value === 'meta' && !metaSelecionada.value) { alert("Selecione a Meta."); return; }
  if (tipo.value === 'despesa' && !categoriaSelecionada.value) { alert("Selecione a categoria."); return; }
  if (tipo.value === 'receita' && !categoriaSelecionada.value) { alert("Selecione a categoria."); return; }

  try {
    const valBase = parseFloat(valor.value);
    const transacaoObj = { tipo: tipo.value, descricao: descricao.value, responsavel: responsavel.value, conta: contaSelecionada.value, data: dataLancamento.value };
    
    let urlDoArquivo = '';
    if (arquivoComprovante.value) {
      uploadProgresso.value = true;
      const formData = new FormData();
      formData.append('file', arquivoComprovante.value);
      formData.append('upload_preset', 'SEU_UPLOAD_PRESET'); 
      
      try {
        const response = await fetch(`https://api.cloudinary.com/v1_1/SEU_CLOUD_NAME/upload`, { method: 'POST', body: formData });
        const dataCloudinary = await response.json();
        if(dataCloudinary.secure_url) urlDoArquivo = dataCloudinary.secure_url;
      } catch (err) {
        alert("Erro ao enviar o comprovante.");
      }
      uploadProgresso.value = false;
    }
    if (urlDoArquivo) transacaoObj.comprovanteUrl = urlDoArquivo;

    if (tipo.value === 'meta') {
      let valorRestante = valBase;
      let indiceAtual = metasPendentes.value.findIndex(m => m.id === metaSelecionada.value);
      
      if (indiceAtual === -1) indiceAtual = 0; 
      if (metasPendentes.value.length === 0) { alert("Todas as metas foram atingidas!"); return; }

      let feedbackMsg = "";
      while (valorRestante > 0 && indiceAtual < metasPendentes.value.length) {
        const metaCorrente = metasPendentes.value[indiceAtual];
        const falta = metaCorrente.valorObjetivo - metaCorrente.valorAtual;
        
        if (falta > 0) {
          const aporte = Math.min(valorRestante, falta);
          await addDoc(getColecao("transacoes"), { 
            ...transacaoObj, valor: aporte, metaId: metaCorrente.id, nomeMeta: metaCorrente.nome,
            descricao: `${descricao.value}${metaCorrente.id !== metaSelecionada.value ? ' (Automático)' : ''}`
          });
          await updateDoc(getDocRef("metas", metaCorrente.id), { valorAtual: metaCorrente.valorAtual + aporte });
          if (aporte === falta) soltarConfetes();
          valorRestante -= aporte;
        }

        if (valorRestante > 0) {
          indiceAtual++;
          if (indiceAtual >= metasPendentes.value.length) {
            feedbackMsg = `Meta atingida! Restante de ${formatarMoeda(valorRestante)} não debitado.`; break;
          } else {
            feedbackMsg = `Meta atingida! Excedente transferido para "${metasPendentes.value[indiceAtual].nome}".`;
          }
        } else {
          feedbackMsg = "Aporte registrado.";
        }
      }
      alert(feedbackMsg);

    } else {
      transacaoObj.valor = valBase;
      if (tipo.value === 'transferencia') {
        transacaoObj.beneficiario = beneficiario.value;
        transacaoObj.contaDestino = contaDestinoSelecionada.value;
      } else {
        transacaoObj.categoria = categoriaSelecionada.value;
        transacaoObj.subcategoria = subcategoriaSelecionada.value || '';
      }

      if (isParcelado.value) {
        const qtd = parseInt(numeroParcelas.value);
        for (let i = 0; i < qtd; i++) {
          await addDoc(getColecao("transacoes"), { ...transacaoObj, descricao: `${descricao.value} (${i + 1}/${qtd})`, valor: valBase / qtd, data: calcularDataFutura(dataPrimeiraParcela.value, i) });
        }
      } else {
        await addDoc(getColecao("transacoes"), transacaoObj);
      }
    }
    
    descricao.value = ''; valor.value = ''; isParcelado.value = false; numeroParcelas.value = 2; arquivoComprovante.value = null;
    document.getElementById("input-comprovante").value = "";
  } catch (e) { alert("Erro ao salvar."); uploadProgresso.value = false; }
}

const apagarTransacao = async (t) => { 
  if (confirm("Apagar registro?")) {
    await deleteDoc(getDocRef("transacoes", t.id));
    if (t.tipo === 'meta') {
      const metaObj = metas.value.find(m => m.id === t.metaId);
      if (metaObj) await updateDoc(getDocRef("metas", metaObj.id), { valorAtual: metaObj.valorAtual - t.valor });
    }
  }
}

// ==========================================
// MÓDULOS DE INTELIGÊNCIA DO DASHBOARD E EXPORTAÇÃO
// ==========================================

const transacoesFiltradas = computed(() => {
  if (!mesFiltro.value) return transacoes.value;
  return transacoes.value.filter(t => t.data && t.data.startsWith(mesFiltro.value));
});

// NOVO: Funções de Exportação
const exportarCSV = () => {
  if (transacoesFiltradas.value.length === 0) { alert("Nenhum dado para exportar neste mês."); return; }
  
  // O formato CSV padrão no Brasil usa ponto-e-vírgula como separador para não conflitar com os centavos
  let csv = 'Data;Descrição;Categoria/Meta;Conta Origem;Conta Destino;Responsável;Beneficiário;Tipo;Valor\n';
  
  transacoesFiltradas.value.forEach(t => {
    const data = formatarData(t.data);
    const desc = t.descricao.replace(/;/g, ','); // Limpa possíveis ponto-e-vírgulas da descrição
    const cat = t.tipo === 'meta' ? `Meta: ${t.nomeMeta}` : (t.tipo === 'transferencia' ? 'Transferência' : `${t.categoria} ${t.subcategoria ? ' - ' + t.subcategoria : ''}`);
    const conta = t.conta;
    const contaDest = t.contaDestino || '';
    const resp = extrairNome(t.responsavel);
    const ben = extrairNome(t.beneficiario) || '';
    const tipoStr = t.tipo.toUpperCase();
    const val = t.valor.toString().replace('.', ','); // Converte o ponto do banco para vírgula no Excel BR

    csv += `${data};${desc};${cat};${conta};${contaDest};${resp};${ben};${tipoStr};${val}\n`;
  });

  // O BOM (Byte Order Mark) é necessário para o Excel ler acentos corretamente
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `HomeManager_Relatorio_${mesFiltro.value}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const exportarPDF = () => {
  if (transacoesFiltradas.value.length === 0) { alert("Nenhum dado para exportar neste mês."); return; }
  
  const doc = new jsPDF();
  
  // Título do PDF
  doc.setFontSize(16);
  doc.setTextColor(30, 41, 59);
  doc.text(`Relatório Financeiro: ${mesFormatado.value}`, 14, 20);
  
  // Colunas
  const columns = ["Data", "Descrição", "Categoria/Meta", "Conta", "Resp.", "Valor"];
  
  // Linhas
  const rows = transacoesFiltradas.value.map(t => [
    formatarData(t.data),
    t.descricao,
    t.tipo === 'meta' ? `Meta: ${t.nomeMeta}` : (t.tipo === 'transferencia' ? 'Acerto' : t.categoria),
    t.tipo === 'transferencia' && t.contaDestino ? `${t.conta} > ${t.contaDestino}` : t.conta,
    t.tipo === 'transferencia' ? `${extrairNome(t.responsavel)} > ${extrairNome(t.beneficiario)}` : extrairNome(t.responsavel),
    `${t.tipo === 'receita' ? '+' : t.tipo === 'despesa' ? '-' : t.tipo === 'meta' ? '↓' : '↔'} ${formatarMoeda(t.valor)}`
  ]);

  // Geração da Tabela Automática (MUDANÇA AQUI)
  autoTable(doc, {
    head: [columns],
    body: rows,
    startY: 30,
    theme: 'striped',
    styles: { fontSize: 8, font: 'helvetica', cellPadding: 3 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 5: { halign: 'right', fontStyle: 'bold' } } 
  });

  doc.save(`HomeManager_Relatorio_${mesFiltro.value}.pdf`);
};

// ... RESTANTE DO CÓDIGO COMPUTADO
const transacoesAcumuladasAteMes = computed(() => {
  if (!mesFiltro.value) return transacoes.value;
  const ultimoDia = mesFiltro.value + '-31'; 
  return transacoes.value.filter(t => t.data <= ultimoDia);
});

const despesasMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'despesa'));
const receitasMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'receita'));
const aportesMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'meta')); 

const totalReceitas = computed(() => receitasMes.value.reduce((a, t) => a + t.valor, 0));
const totalDespesas = computed(() => despesasMes.value.reduce((a, t) => a + t.valor, 0));
const totalAportes = computed(() => aportesMes.value.reduce((a, t) => a + t.valor, 0)); 

const saldoAtual = computed(() => totalReceitas.value - totalDespesas.value - totalAportes.value);

const orcamentosStatus = computed(() => {
  const gastosPorCategoria = {};
  despesasMes.value.forEach(t => { gastosPorCategoria[t.categoria] = (gastosPorCategoria[t.categoria] || 0) + t.valor; });

  return categoriasDisponiveis.value
    .filter(c => c.limiteMensal && c.limiteMensal > 0)
    .map(c => {
      const gasto = gastosPorCategoria[c.nome] || 0;
      const pct = (gasto / c.limiteMensal) * 100;
      let cor = '#10b981'; 
      if (pct >= 100) cor = '#ef4444'; 
      else if (pct >= 80) cor = '#f59e0b'; 
      return { nome: c.nome, limite: c.limiteMensal, gasto: gasto, percentual: pct, cor: cor };
    })
    .sort((a, b) => b.percentual - a.percentual); 
});

const chartData = computed(() => {
  const totaisPorCategoria = {};
  despesasMes.value.forEach(t => { totaisPorCategoria[t.categoria] = (totaisPorCategoria[t.categoria] || 0) + t.valor; });
  if (totalAportes.value > 0) totaisPorCategoria['🎯 Guardado (Metas)'] = totalAportes.value;

  return {
    labels: Object.keys(totaisPorCategoria),
    datasets: [{
      data: Object.values(totaisPorCategoria),
      backgroundColor: ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#64748b', '#10b981'],
      borderWidth: 0, hoverOffset: 4
    }]
  }
});
const chartOptions = computed(() => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: temaEscuro.value ? '#cbd5e1' : '#334155', font: { size: 11 } } } } }));

const saldosFamilia = computed(() => {
  const saldos = {};
  if (familiaAtual.value && familiaAtual.value.membros) {
    familiaAtual.value.membros.forEach(email => saldos[email] = 0);
  }
  transacoesAcumuladasAteMes.value.forEach(t => {
    if (t.tipo === 'transferencia') {
      if (t.responsavel) { if (saldos[t.responsavel] === undefined) saldos[t.responsavel] = 0; saldos[t.responsavel] += t.valor; }
      if (t.beneficiario) { if (saldos[t.beneficiario] === undefined) saldos[t.beneficiario] = 0; saldos[t.beneficiario] -= t.valor; }
    }
  });
  return Object.keys(saldos).map(email => ({
    email: email, nome: extrairNome(email), valor: saldos[email]
  })).filter(m => m.valor !== 0).sort((a, b) => b.valor - a.valor);
});

const custoEstacoes = computed(() => despesasMes.value.filter(t => t.categoria === 'Apto Estações' || t.categoria === 'AptoEstações').reduce((a, t) => a + t.valor, 0));
const custoBaependi = computed(() => despesasMes.value.filter(t => t.categoria === 'Apto Baependi' || t.categoria === 'AptoBaependi').reduce((a, t) => a + t.valor, 0));

const compromissosFuturos = computed(() => transacoes.value.filter(t => t.tipo === 'despesa' && t.data > mesFiltro.value + '-31').reduce((a, t) => a + t.valor, 0));
const totalDividasAtivas = computed(() => transacoes.value.filter(t => t.tipo === 'despesa' && t.categoria === 'Dívidas').reduce((a, t) => a + t.valor, 0));

onMounted(() => {
  onAuthStateChanged(auth, async (user) => {
    usuarioLogado.value = user;
    if (user) {
      responsavel.value = user.email.toLowerCase(); 
      const qFamilia = query(collection(db, "familias"), where("membros", "array-contains", user.email.toLowerCase()));
      const querySnapshot = await getDocs(qFamilia);
      
      if (!querySnapshot.empty) {
        const docFamilia = querySnapshot.docs[0];
        familiaAtual.value = { id: docFamilia.id, ...docFamilia.data() };
        iniciarListenersDaFamilia(familiaAtual.value.id);
        telaAtual.value = 'dashboard';
      } else {
        telaAtual.value = 'sem_familia';
      }
    }
    carregandoAuth.value = false;
  });
});

const formatarMoeda = (val) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Math.abs(val));
const formatarData = (d) => d ? d.split('-').reverse().join('/') : '';
</script>

<template>
  
  <div v-if="carregandoAuth" class="tela-loading"><div class="spinner"></div><p>Carregando...</p></div>

  <div v-else-if="!usuarioLogado" class="tela-login">
    <div class="login-card animacao-entrada">
      <div class="logo-login"><h2>HomeManager</h2><p>Inteligência financeira</p></div>
      <button @click="loginComGoogle" class="btn-google">
        <img src="https://upload.wikimedia.org/wikipedia/commons/5/53/Google_%22G%22_Logo.svg" alt="Google" class="google-icon" />
        Entrar com Google
      </button>
    </div>
  </div>

  <div v-else-if="telaAtual === 'sem_familia'" class="tela-login">
    <div class="login-card animacao-entrada" style="max-width: 500px;">
      <div class="logo-login"><h2>Bem-vindo!</h2><p>Você não possui um ambiente.</p></div>
      <div class="box-clean mb-20">
        <h4>Criar novo ambiente</h4>
        <p class="text-sm text-muted">Crie um cofre financeiro do zero e convide pessoas.</p>
        <button @click="criarFamilia" class="btn-salvar-elegante mt-10">Criar Minha Família</button>
      </div>
      <div class="box-clean mb-20">
        <h4>Fui convidado</h4>
        <p class="text-sm text-muted">Seu e-mail é <strong>{{ usuarioLogado.email }}</strong>. Peça para o administrador adicionar este e-mail no sistema.</p>
      </div>
      <button @click="fazerLogout" class="btn-link text-danger">Sair da Conta</button>
    </div>
  </div>

  <div v-else class="app-layout" :class="temaEscuro ? 'tema-escuro' : 'tema-claro'">
    
    <aside class="sidebar">
      <div class="logo">
        <h2>HomeManager</h2>
        <div class="perfil-card">
          <img :src="usuarioLogado.photoURL" alt="Avatar" class="avatar-google" referrerpolicy="no-referrer" />
          <div class="perfil-info">
            <span class="nome-usuario">{{ usuarioLogado.displayName.split(' ')[0] }}</span>
            <div class="perfil-acoes"><button @click="fazerLogout">Sair da Conta</button></div>
          </div>
        </div>
      </div>

      <nav class="menu">
        <button @click="telaAtual = 'dashboard'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'dashboard' }">Dashboard</button>
        <button @click="telaAtual = 'metas'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'metas' }">Metas e Objetivos</button>
        
        <div class="menu-grupo">
          <button @click="menuLancamentosAberto = !menuLancamentosAberto" class="btn-grupo">
            Lançamentos <span class="seta-menu">{{ menuLancamentosAberto ? '▼' : '▶' }}</span>
          </button>
          <div v-show="menuLancamentosAberto" class="submenu">
            <button @click="telaAtual = 'lancamentos'" :class="{ ativo: telaAtual === 'lancamentos' }">Registros</button>
            <button @click="telaAtual = 'categorias'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'categorias' }">Categorias</button>
            <button @click="telaAtual = 'contas'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'contas' }">Contas e Cartões</button>
          </div>
        </div>
        <button @click="telaAtual = 'familia'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'familia' }">Minha Família</button>
      </nav>
    </aside>

    <main class="conteudo-principal">
      <header class="barra-topo flex-header">
        <h1>
          {{ telaAtual === 'dashboard' ? 'Dashboard Financeiro' : 
             telaAtual === 'metas' ? 'Metas e Objetivos' :
             telaAtual === 'lancamentos' ? 'Gestão de Lançamentos' : 
             telaAtual === 'categorias' ? 'Estrutura de Categorias' : 
             telaAtual === 'contas' ? 'Contas e Cartões' : 'Configurações da Família' }}
        </h1>
        <div class="navegador-mes" v-if="telaAtual === 'dashboard' || telaAtual === 'lancamentos'">
          <button @click="alterarMes(-1)" class="btn-seta">&lt;</button>
          <span class="mes-display">{{ mesFormatado }}</span>
          <button @click="alterarMes(1)" class="btn-seta">&gt;</button>
        </div>
      </header>

      <section v-if="telaAtual === 'metas'" class="tela-metas animacao-entrada">
        <div class="cartao form-elegante">
          <h2 class="titulo-clean">Nova Meta Financeira</h2>
          <form @submit.prevent="adicionarMeta" class="formulario em-linha">
            <div class="campo flex-grow"><input v-model="novaMetaNome" type="text" placeholder="Nome do objetivo..." required /></div>
            <div class="campo"><input v-model="novaMetaObjetivo" type="number" step="0.01" placeholder="Objetivo (R$)" required /></div>
            <div class="campo"><input v-model="novaMetaAtual" type="number" step="0.01" placeholder="Já guardado (R$)" /></div>
            <button type="submit" class="btn-salvar-secundario">Criar</button>
          </form>
        </div>

        <div class="grid-metas mt-20">
          <div class="cartao meta-card" :class="{'atingida': meta.valorAtual >= meta.valorObjetivo}" v-for="meta in metas" :key="meta.id">
            <div class="meta-cabecalho"><h3 class="titulo-widget mb-0">{{ meta.nome }}</h3><button @click="removerMeta(meta.id)" class="btn-fechar">✖</button></div>
            <p class="meta-valores">{{ formatarMoeda(meta.valorAtual) }} <span class="text-muted">de {{ formatarMoeda(meta.valorObjetivo) }}</span></p>
            
            <div class="barra-progresso-fundo mb-20">
              <div class="barra-progresso-preenchida" :style="{ width: Math.min((meta.valorAtual / meta.valorObjetivo) * 100, 100) + '%' }"></div>
            </div>
            
            <div class="meta-acoes">
              <span class="meta-percentual" v-if="meta.valorAtual < meta.valorObjetivo">{{ Math.round((meta.valorAtual / meta.valorObjetivo) * 100) }}% concluído</span>
              <span class="meta-percentual-atingida" v-else>🎉 Meta Atingida!</span>
              
              <button v-if="meta.valorAtual < meta.valorObjetivo" @click="iniciarAporte(meta)" class="btn-salvar-secundario btn-sm">Guardar Dinheiro</button>
            </div>
          </div>
          <div v-if="metas.length === 0" class="cartao vazio-widget" style="grid-column: span 2;">Nenhuma meta cadastrada.</div>
        </div>
      </section>

      <section v-if="telaAtual === 'familia'" class="tela-familia animacao-entrada">
        <div class="cartao form-elegante">
          <h2 class="titulo-clean">Membros da Família</h2>
          <div class="tabela-responsiva mb-20 mt-20">
            <table class="tabela">
              <thead><tr><th>E-mail</th><th>Nome</th><th>Ações</th></tr></thead>
              <tbody>
                <tr v-for="email in familiaAtual.membros" :key="email">
                  <td><strong>{{ email }}</strong></td><td><span class="etiqueta-limpa">{{ extrairNome(email) }}</span></td>
                  <td>
                    <button v-if="email !== usuarioLogado.email" @click="removerMembro(email)" class="btn-link text-danger">Revogar Acesso</button>
                    <span v-else class="text-muted text-sm">Você</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3 class="titulo-clean mt-30">Convidar Pessoa</h3>
          <form @submit.prevent="convidarMembro" class="formulario em-linha">
            <div class="campo flex-grow"><input v-model="emailConvite" type="email" placeholder="E-mail do novo membro..." required /></div>
            <button type="submit" class="btn-salvar-secundario" :disabled="statusEnvio !== ''">{{ statusEnvio || 'Enviar Convite' }}</button>
          </form>
        </div>
      </section>

      <section v-if="telaAtual === 'dashboard'" class="tela-dashboard animacao-entrada">
        <div class="grid-resumo mb-20">
          <div class="cartao-resumo receitas"><h3>Receitas</h3><p>{{ formatarMoeda(totalReceitas) }}</p></div>
          <div class="cartao-resumo despesas"><h3>Despesas / Metas</h3><p>{{ formatarMoeda(totalDespesas + totalAportes) }}</p></div>
          <div class="cartao-resumo saldo" :class="saldoAtual >= 0 ? 'saldo-positivo' : 'saldo-negativo'"><h3>Saldo Livre</h3><p>{{ formatarMoeda(saldoAtual) }}</p></div>
        </div>

        <div class="dashboard-bento">
          <div class="cartao bento-item widget-orcamento" style="grid-column: span 2;">
            <h3 class="titulo-widget">Monitor de Orçamentos</h3>
            <div v-if="orcamentosStatus.length > 0" class="lista-metas-dash">
              <div v-for="orc in orcamentosStatus" :key="orc.nome" class="meta-item-dash mb-20">
                <div class="meta-header-dash">
                  <span class="font-weight-bold">{{ orc.nome }}</span>
                  <span class="text-sm" :style="{ color: orc.cor, fontWeight: '600' }">{{ formatarMoeda(orc.gasto) }} / {{ formatarMoeda(orc.limite) }}</span>
                </div>
                <div class="barra-progresso-fundo mt-10"><div class="barra-progresso-preenchida" :style="{ width: Math.min(orc.percentual, 100) + '%', backgroundColor: orc.cor }"></div></div>
              </div>
            </div>
            <div v-else class="vazio-widget">Nenhum limite definido nas Categorias.</div>
          </div>

          <div class="cartao bento-item widget-metas">
            <h3 class="titulo-widget">Progresso das Metas</h3>
            <div v-if="metas.length > 0" class="lista-metas-dash">
              <div v-for="meta in metas.slice(0, 3)" :key="meta.id" class="meta-item-dash mb-20">
                <div class="meta-header-dash">
                  <span class="font-weight-bold" :class="{'texto-verde': meta.valorAtual >= meta.valorObjetivo}">{{ meta.nome }} {{ meta.valorAtual >= meta.valorObjetivo ? '🎉' : '' }}</span>
                  <span class="text-muted text-sm">{{ formatarMoeda(meta.valorAtual) }}</span>
                </div>
                <div class="barra-progresso-fundo mt-10"><div class="barra-progresso-preenchida" :style="{ width: Math.min((meta.valorAtual / meta.valorObjetivo) * 100, 100) + '%', backgroundColor: meta.valorAtual >= meta.valorObjetivo ? '#10b981' : 'var(--meta-cor)' }"></div></div>
              </div>
            </div>
            <div v-else class="vazio-widget">Nenhuma meta ativa.</div>
          </div>

          <div class="cartao bento-item grafico-container">
            <h3 class="titulo-widget">Distribuição</h3>
            <div class="grafico-wrapper" v-if="despesasMes.length > 0 || aportesMes.length > 0"><Doughnut :data="chartData" :options="chartOptions" /></div>
            <div v-else class="vazio-widget">Sem saídas no mês.</div>
          </div>
          
          <div class="cartao bento-item widget-casal" style="grid-column: span 2;">
            <h3 class="titulo-widget">Conta Corrente da Família</h3>
            <div v-if="saldosFamilia.length > 0" class="grid-metas mt-20">
              <div v-for="membro in saldosFamilia" :key="membro.email" class="barra-pessoa">
                <span>{{ membro.nome }}</span>
                <strong :class="membro.valor > 0 ? 'texto-verde' : 'texto-vermelho'">{{ membro.valor > 0 ? '+ A receber: ' : '- A pagar: ' }}{{ formatarMoeda(membro.valor) }}</strong>
              </div>
            </div>
            <div v-else class="vazio-widget">Nenhuma transferência pendente na família. Tudo quite.</div>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'lancamentos'" class="tela-lancamentos animacao-entrada">
        <button v-if="!mostrarFormulario" @click="alternarFormulario" class="fab-btn animacao-entrada" title="Novo Lançamento">+</button>

        <div v-if="mostrarFormulario" class="cartao form-elegante animacao-entrada mb-20">
          <div class="cabecalho-form"><h2 class="titulo-clean mb-0">Novo Lançamento</h2><button @click="alternarFormulario" class="btn-fechar-form">✖</button></div>
          <div v-if="categoriasDisponiveis.length === 0 || contasDisponiveis.length === 0" class="alerta-categorias">Cadastre 1 Categoria e 1 Conta para lançar.</div>
          
          <form v-else @submit.prevent="adicionarTransacao" class="formulario">
            <div class="toggle-container quadruplo">
              <button type="button" :class="['btn-toggle', tipo === 'despesa' ? 'ativo-despesa' : '']" @click="tipo = 'despesa'">Despesa</button>
              <button type="button" :class="['btn-toggle', tipo === 'receita' ? 'ativo-receita' : '']" @click="tipo = 'receita'">Receita</button>
              <button type="button" :class="['btn-toggle', tipo === 'transferencia' ? 'ativo-transferencia' : '']" @click="tipo = 'transferencia'">Transferência</button>
              <button type="button" :class="['btn-toggle', tipo === 'meta' ? 'ativo-meta' : '']" @click="tipo = 'meta'" :disabled="metasPendentes.length === 0">Meta</button>
            </div>
            
            <div class="linha-campos mt-20">
              <div class="campo"><label>Data</label><input v-model="dataLancamento" type="date" required /></div>
              <div class="campo campo-largo"><label>Descrição</label><input v-model="descricao" type="text" required /></div>
              <div class="campo"><label>Valor (R$)</label><input v-model="valor" type="number" step="0.01" required /></div>
            </div>
            
            <div class="linha-campos">
              <div class="campo">
                <label>{{ tipo === 'receita' ? 'Conta de Entrada' : 'Conta de Saída' }}</label>
                <select v-model="contaSelecionada" required><option v-for="conta in contasDisponiveis" :key="conta.id" :value="conta.nome">{{ conta.nome }}</option></select>
              </div>

              <div v-if="tipo === 'transferencia'" class="campo">
                <label>Conta de Destino</label>
                <select v-model="contaDestinoSelecionada" required><option v-for="conta in contasDisponiveis" :key="conta.id" :value="conta.nome">{{ conta.nome }}</option></select>
              </div>
              
              <div class="campo">
                <label>Responsável</label>
                <select v-model="responsavel" required><option v-for="membro in familiaAtual.membros" :key="membro" :value="membro">{{ extrairNome(membro) }}</option></select>
              </div>

              <div v-if="tipo === 'transferencia'" class="campo">
                <label>Beneficiário</label>
                <select v-model="beneficiario" required><option v-for="membro in familiaAtual.membros" :key="membro" :value="membro">{{ extrairNome(membro) }}</option></select>
              </div>
              <div v-else-if="tipo === 'meta'" class="campo">
                <label>Meta</label>
                <select v-model="metaSelecionada" required><option v-for="m in metasPendentes" :key="m.id" :value="m.id">{{ m.nome }}</option></select>
              </div>
              <template v-else>
                <div class="campo"><label>Categoria</label><select v-model="categoriaSelecionada" required><option v-for="cat in categoriasDisponiveis" :key="cat.id" :value="cat.nome">{{ cat.nome }}</option></select></div>
                <div class="campo"><label>Subcategoria</label><select v-model="subcategoriaSelecionada" :disabled="subcategoriasDropdown.length === 0"><option v-if="subcategoriasDropdown.length === 0" value="">-- Nenhuma --</option><option v-for="sub in subcategoriasDropdown" :key="sub" :value="sub">{{ sub }}</option></select></div>
              </template>
            </div>
            
            <div class="secao-parcelamento" v-if="tipo !== 'meta'">
              <label class="checkbox-sutil"><input type="checkbox" v-model="isParcelado"><span class="texto-check">Lançamento Parcelado / Recorrente</span></label>
              <div v-if="isParcelado" class="opcoes-parcelamento animacao-entrada">
                <div class="campo campo-pequeno"><label>Parcelas</label><input v-model="numeroParcelas" type="number" min="2" max="120" /></div>
                <div class="campo"><label>Vencimento 1ª Parcela</label><input v-model="dataPrimeiraParcela" type="date" required /></div>
              </div>
            </div>

            <div class="linha-campos mb-20 mt-20" style="border-top: 1px dashed var(--borda); padding-top: 20px;">
              <div class="campo">
                <label>Comprovante / Nota Fiscal</label>
                <input type="file" id="input-comprovante" @change="selecionarArquivo" accept="image/*,application/pdf" class="input-arquivo" />
              </div>
            </div>

            <button type="submit" :class="['btn-salvar-elegante', `btn-cor-${tipo}`]" :disabled="uploadProgresso">
              {{ uploadProgresso ? 'Registrando...' : 'Salvar Registro' }}
            </button>
          </form>
        </div>

        <div class="cartao mt-20">
          <div class="cabecalho-lista-tabela">
            <h3 class="titulo-clean mb-0">Registros do Mês</h3>
            <div class="acoes-exportacao">
              <button @click="exportarCSV" class="btn-export">Exportar Excel (CSV)</button>
              <button @click="exportarPDF" class="btn-export pdf-btn">Exportar PDF</button>
            </div>
          </div>

          <div class="tabela-responsiva mt-20">
            <table class="tabela">
              <thead><tr><th>Data</th><th>Descrição / Conta</th><th>Categoria</th><th>Resp. / Origem</th><th>Valor</th><th>Ações</th></tr></thead>
              <tbody>
                <tr v-if="transacoesFiltradas.length === 0"><td colspan="6" class="centro text-muted">Nenhum lançamento no período.</td></tr>
                <tr v-for="t in transacoesFiltradas" :key="t.id">
                  <td>{{ formatarData(t.data) }}</td>
                  <td>
                    <div class="descricao-celula">
                      <span class="desc-texto">
                        {{ t.descricao }} 
                        <a v-if="t.comprovanteUrl" :href="t.comprovanteUrl" target="_blank" class="link-comprovante">[Ver Anexo]</a>
                      </span>
                      <span class="etiqueta-pagamento">
                        {{ t.tipo === 'transferencia' && t.contaDestino ? t.conta + ' ➔ ' + t.contaDestino : t.conta || '-' }}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span v-if="t.tipo === 'transferencia'" class="etiqueta-transf">Acerto</span>
                    <span v-else-if="t.tipo === 'meta'" class="etiqueta-meta">🎯 Meta: {{ t.nomeMeta }}</span>
                    <span v-else class="etiqueta-limpa">{{ t.categoria }} {{ t.subcategoria ? ' / ' + t.subcategoria : '' }}</span>
                  </td>
                  <td>
                    <span v-if="t.tipo === 'transferencia'">{{ extrairNome(t.responsavel) }} ➔ {{ extrairNome(t.beneficiario) }}</span>
                    <span v-else>{{ extrairNome(t.responsavel) }}</span>
                  </td>
                  <td :class="t.tipo === 'receita' ? 'texto-verde' : t.tipo === 'despesa' ? 'texto-vermelho' : t.tipo === 'meta' ? 'texto-azul' : 'texto-roxo'">
                    {{ t.tipo === 'receita' ? '+' : t.tipo === 'despesa' ? '-' : t.tipo === 'meta' ? '↓' : '↔' }} {{ formatarMoeda(t.valor) }}
                  </td>
                  <td><button @click="apagarTransacao(t)" class="btn-link-apagar">Apagar</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'categorias'" class="tela-categorias animacao-entrada">
        
        <div class="cartao cartao-importacao form-elegante">
          <h2 class="titulo-clean">Importação (CSV)</h2>
          <p class="text-muted mb-20 text-sm">Coluna A = Categoria Principal | Coluna B = Subcategoria</p>
          <input type="file" accept=".csv" @change="importarCSV" class="input-arquivo" />
        </div>

        <div class="cartao form-elegante mt-20">
          <h2 class="titulo-clean">Nova Categoria Manual</h2>
          <form @submit.prevent="adicionarCategoria" class="formulario em-linha">
            <input v-model="novaCategoria" type="text" placeholder="Nome..." required class="flex-grow" />
            <button type="submit" class="btn-salvar-secundario">Adicionar</button>
          </form>
        </div>
        
        <div class="cartao mt-20" v-for="cat in categoriasDisponiveis" :key="cat.id">
          <div class="cabecalho-categoria">
            <div class="info-cat-header">
              <h3 class="titulo-categoria mb-0">{{ cat.nome }}</h3>
              <span class="etiqueta-limite ml-10" :class="{'tem-limite': cat.limiteMensal > 0}">
                {{ cat.limiteMensal > 0 ? `Teto: ${formatarMoeda(cat.limiteMensal)}` : 'Sem teto' }}
              </span>
            </div>
            <div class="acoes-categoria">
              <button @click="definirLimite(cat)" class="btn-link text-primary">Definir Limite</button>
              <button @click="editarCategoria(cat)" class="btn-link">Editar</button>
              <button @click="removerCategoria(cat.id)" class="btn-link text-danger">Excluir</button>
            </div>
          </div>
          <div class="area-subcategorias">
            <div class="etiquetas-subcategorias">
              <span v-for="sub in cat.subcategorias" :key="sub" class="etiqueta-sub">{{ sub }} <button @click="removerSubcategoria(cat, sub)" class="btn-fechar">X</button></span>
              <span v-if="cat.subcategorias.length === 0" class="texto-dica text-sm">Vazio.</span>
            </div>
            <form @submit.prevent="adicionarSubcategoria(cat)" class="form-subcategoria">
              <input v-model="inputsSubcategoria[cat.id]" type="text" placeholder="Subcategoria..." class="input-pequeno"/><button type="submit" class="btn-add-mini">+</button>
            </form>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'contas'" class="tela-contas animacao-entrada">
        <div class="cartao form-elegante">
          <h2 class="titulo-clean">Nova Conta</h2>
          <form @submit.prevent="adicionarConta" class="formulario em-linha">
            <div class="campo flex-grow"><input v-model="novaContaNome" type="text" placeholder="Nome da instituição..." required /></div>
            <div class="campo"><select v-model="novaContaTipo" required><option>Cartão de Crédito</option><option>Cartão de Débito</option><option>Conta Bancária</option><option>Dinheiro Espécie</option><option>Vale</option></select></div>
            <button type="submit" class="btn-salvar-secundario">Criar</button>
          </form>
        </div>
        <div class="cartao mt-20">
          <div class="tabela-responsiva">
            <table class="tabela">
              <thead><tr><th>Instituição</th><th>Tipo</th><th>Ações</th></tr></thead>
              <tbody>
                <tr v-if="contasDisponiveis.length === 0"><td colspan="3" class="centro text-muted">Nenhuma conta cadastrada.</td></tr>
                <tr v-for="conta in contasDisponiveis" :key="conta.id">
                  <td><strong>{{ conta.nome }}</strong></td><td><span class="etiqueta-limpa">{{ conta.tipo }}</span></td>
                  <td><button @click="editarConta(conta)" class="btn-link" style="margin-right:15px;">Editar</button><button @click="removerConta(conta.id)" class="btn-link text-danger">Excluir</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

    </main>
    <button @click="alternarTema" class="fab-tema" :title="temaEscuro ? 'Modo Claro' : 'Modo Escuro'">{{ temaEscuro ? '☀️' : '🌙' }}</button>
  </div>
</template>

<style scoped>
.tela-loading, .tela-login { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; background: #f8fafc; font-family: 'Inter', sans-serif; color: #334155; }
.spinner { border: 3px solid rgba(59, 130, 246, 0.1); border-left-color: #3b82f6; border-radius: 50%; width: 32px; height: 32px; animation: spin 1s linear infinite; margin-bottom: 20px; }
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

.login-card { background: white; padding: 50px 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.03); text-align: center; max-width: 380px; width: 90%; border: 1px solid #e2e8f0;}
.logo-login h2 { margin: 0 0 5px 0; font-size: 1.8rem; color: #0f172a; font-weight: 700; letter-spacing: -0.5px;}
.logo-login p { color: #64748b; margin-bottom: 35px; font-size: 0.95rem; }
.box-clean { background: #f8fafc; padding: 20px; border-radius: 8px; text-align: left; border: 1px solid #e2e8f0; }
.box-clean h4 { margin-top: 0; margin-bottom: 5px; color: #334155; font-size: 0.95rem;}
.btn-google { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 12px; background: white; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.95rem; font-weight: 600; color: #334155; cursor: pointer; transition: 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
.btn-google:hover { background: #f8fafc; border-color: #94a3b8; }
.google-icon { width: 18px; height: 18px; }

.tema-claro { --bg-app: #f8fafc; --bg-sidebar: #0f172a; --text-sidebar: #94a3b8; --bg-cartao: #ffffff; --bg-form: #ffffff; --text-principal: #1e293b; --text-muted: #64748b; --borda: #e2e8f0; --input-bg: #f8fafc; --input-border: #cbd5e1; --primary: #2563eb; --receita: #059669; --despesa: #dc2626; --transferencia: #7c3aed; --meta-cor: #0284c7;}
.tema-escuro { --bg-app: #0f172a; --bg-sidebar: #020617; --text-sidebar: #64748b; --bg-cartao: #1e293b; --bg-form: #1e293b; --text-principal: #f8fafc; --text-muted: #94a3b8; --borda: #334155; --input-bg: #0f172a; --input-border: #475569; --primary: #3b82f6; --receita: #10b981; --despesa: #ef4444; --transferencia: #8b5cf6; --meta-cor: #0ea5e9;}

.app-layout { display: flex; min-height: 100vh; background-color: var(--bg-app); color: var(--text-principal); font-family: 'Inter', sans-serif; transition: 0.3s; }

.sidebar { width: 260px; background-color: var(--bg-sidebar); color: var(--text-sidebar); display: flex; flex-direction: column; flex-shrink: 0; border-right: 1px solid rgba(255,255,255,0.05);}
.logo { padding: 35px 25px 25px 25px; }
.logo h2 { margin: 0 0 25px 0; font-size: 1.3rem; color: #f8fafc; font-weight: 700; letter-spacing: -0.5px;}
.perfil-card { display: flex; align-items: center; gap: 12px; }
.avatar-google { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; }
.perfil-info { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.nome-usuario { font-weight: 500; color: #f8fafc; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.perfil-acoes button { background: none; border: none; color: var(--text-sidebar); font-size: 0.75rem; padding: 0; cursor: pointer; transition: 0.2s; }
.perfil-acoes button:hover { color: #f8fafc; }

.menu { flex-grow: 1; display: flex; flex-direction: column; padding: 10px 0; }
.menu button { background: none; border: none; color: var(--text-sidebar); padding: 14px 25px; text-align: left; font-size: 0.9rem; cursor: pointer; transition: 0.2s; font-weight: 500; width: 100%; display: block; }
.menu button:hover { color: #f8fafc; }
.menu button.ativo { color: #f8fafc; background-color: rgba(255,255,255,0.03); border-right: 3px solid var(--primary); }
.menu-grupo { width: 100%; }
.btn-grupo { display: flex !important; justify-content: space-between; align-items: center; }
.seta-menu { font-size: 0.6rem; opacity: 0.5; }
.submenu { background-color: rgba(0,0,0,0.15); }
.submenu button { padding: 12px 25px 12px 45px; font-size: 0.85rem; } 

.text-sm { font-size: 0.8rem; }
.text-xs { font-size: 0.7rem; }
.font-weight-bold { font-weight: 600; }
.text-primary { color: var(--primary) !important; }

.conteudo-principal { flex-grow: 1; padding: 45px 55px; overflow-y: auto; padding-bottom: 120px; } 
.flex-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 35px; }
.barra-topo h1 { margin: 0; font-size: 1.4rem; font-weight: 700; color: var(--text-principal); letter-spacing: -0.5px;}

/* METAS CSS */
.grid-metas { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
.meta-card { display: flex; flex-direction: column; justify-content: space-between; border: 1px solid var(--borda); transition: 0.2s;}
.meta-card.atingida { background-color: rgba(16, 185, 129, 0.03); border: 1px solid rgba(16, 185, 129, 0.2); }
.meta-cabecalho { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.meta-valores { font-size: 1.4rem; font-weight: 700; color: var(--text-principal); margin: 0 0 15px 0; letter-spacing: -0.5px;}
.meta-valores span { font-size: 0.85rem; font-weight: 500; }
.barra-progresso-fundo { width: 100%; background-color: var(--input-bg); border-radius: 4px; height: 6px; overflow: hidden; }
.barra-progresso-preenchida { background-color: var(--meta-cor); height: 100%; border-radius: 4px; transition: width 0.5s ease; }
.meta-card.atingida .barra-progresso-preenchida { background-color: #10b981; }
.meta-acoes { display: flex; justify-content: space-between; align-items: center; margin-top: 15px; }
.meta-percentual { font-size: 0.8rem; font-weight: 600; color: var(--meta-cor); }
.meta-percentual-atingida { font-size: 0.85rem; font-weight: 600; color: #10b981; }
.meta-header-dash { display: flex; justify-content: space-between; margin-bottom: 8px; }
.mt-10 { margin-top: 10px; }
.mt-20 { margin-top: 20px; }
.mt-30 { margin-top: 30px; }
.mb-15 { margin-bottom: 15px; }
.mb-20 { margin-bottom: 20px; }

.grid-resumo { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.cartao-resumo { background: var(--bg-cartao); padding: 25px; border-radius: 12px; border: 1px solid var(--borda); box-shadow: 0 4px 20px rgba(0,0,0,0.02); }
.cartao-resumo h3 { margin: 0 0 8px 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px;}
.cartao-resumo p { font-size: 1.8rem; font-weight: 700; margin: 0; letter-spacing: -0.5px;}
.receitas p { color: var(--receita); }
.despesas p { color: var(--text-principal); }
.saldo-positivo p { color: var(--primary); }
.saldo-negativo p { color: var(--despesa); }

.dashboard-bento { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
.bento-item { background: var(--bg-cartao); padding: 25px; border-radius: 12px; border: 1px solid var(--borda); box-shadow: 0 4px 20px rgba(0,0,0,0.02); }
.titulo-widget { font-size: 0.95rem; font-weight: 600; margin: 0 0 20px 0; color: var(--text-principal); border-bottom: 1px solid var(--borda); padding-bottom: 12px; }

.grafico-wrapper { height: 240px; position: relative; }
.vazio-widget { text-align: center; padding: 30px; color: var(--text-muted); font-size: 0.9rem;}

.barras-casal { display: flex; flex-direction: column; gap: 12px; }
.barra-pessoa { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--bg-form); border-radius: 6px; border: 1px solid var(--borda);}
.barra-pessoa span { color: var(--text-principal); font-weight: 500; font-size: 0.9rem;}
.barra-pessoa strong { font-size: 1rem; }

.cartao { background: var(--bg-cartao); padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.02); border: 1px solid var(--borda); }
.cartao-importacao { border: 1px dashed var(--input-border); background: transparent; box-shadow: none;}
.input-arquivo { display: block; width: 100%; padding: 12px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--text-principal); border-radius: 6px; font-size: 0.85rem;}
.ml-10 { margin-left: 10px; }
.titulo-clean { font-size: 1rem; font-weight: 600; margin: 0 0 15px 0; color: var(--text-principal); }
.text-muted { color: var(--text-muted); }

.fab-btn { position: fixed; bottom: 40px; right: 40px; width: 56px; height: 56px; border-radius: 50%; background-color: var(--primary); color: white; font-size: 1.8rem; font-weight: 300; border: none; box-shadow: 0 8px 24px rgba(37, 99, 235, 0.3); cursor: pointer; display: flex; justify-content: center; align-items: center; transition: 0.2s; z-index: 100; }
.fab-btn:hover { transform: translateY(-3px); box-shadow: 0 12px 28px rgba(37, 99, 235, 0.4); }
.fab-tema { position: fixed; bottom: 40px; left: 280px; width: 40px; height: 40px; border-radius: 50%; background-color: var(--bg-cartao); border: 1px solid var(--borda); box-shadow: 0 4px 12px rgba(0,0,0,0.05); cursor: pointer; font-size: 1rem; display: flex; justify-content: center; align-items: center; transition: 0.2s; z-index: 100; }
.fab-tema:hover { transform: scale(1.05); }

/* EXPORTAÇÃO */
.cabecalho-lista-tabela { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--borda); padding-bottom: 15px; margin-bottom: 15px; }
.acoes-exportacao { display: flex; gap: 10px; }
.btn-export { padding: 8px 16px; font-size: 0.8rem; font-weight: 600; border-radius: 6px; cursor: pointer; border: 1px solid var(--primary); background: transparent; color: var(--primary); transition: 0.2s; }
.btn-export:hover { background: var(--primary); color: white; }
.pdf-btn { border-color: var(--despesa); color: var(--despesa); }
.pdf-btn:hover { background: var(--despesa); color: white; }

.form-elegante { background-color: var(--bg-cartao); }
.cabecalho-form { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 1px solid var(--borda); padding-bottom: 15px; }
.btn-fechar-form { background: none; border: none; color: var(--text-muted); font-size: 1.2rem; cursor: pointer; transition: 0.2s; }
.btn-fechar-form:hover { color: var(--despesa); }

.formulario { display: flex; flex-direction: column; gap: 18px; }
.linha-campos { display: flex; gap: 18px; flex-wrap: wrap; }
.campo { display: flex; flex-direction: column; flex: 1; min-width: 150px; }
.campo-largo { flex: 2; }
.campo label { font-size: 0.75rem; font-weight: 600; margin-bottom: 6px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;}
input, select { padding: 12px 14px; border-radius: 6px; font-size: 0.9rem; background-color: var(--input-bg); color: var(--text-principal); border: 1px solid var(--input-border); outline: none; transition: 0.2s;}
input:focus, select:focus { border-color: var(--primary); background: transparent;}
input:disabled, select:disabled { opacity: 0.6; cursor: not-allowed; }

.toggle-container { display: flex; background: var(--input-bg); padding: 4px; border-radius: 6px; margin-bottom: 5px; width: 100%; border: 1px solid var(--input-border);}
.quadruplo .btn-toggle { padding: 8px 10px; font-size: 0.8rem;}
.btn-toggle { flex: 1; padding: 8px 25px; border: none; background: transparent; color: var(--text-muted); font-weight: 600; border-radius: 4px; cursor: pointer; transition: 0.2s; }
.btn-toggle:hover:not(:disabled) { color: var(--text-principal); }
.ativo-despesa { background: var(--bg-cartao); color: var(--despesa) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.ativo-receita { background: var(--bg-cartao); color: var(--receita) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.ativo-transferencia { background: var(--bg-cartao); color: var(--transferencia) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.ativo-meta { background: var(--bg-cartao); color: var(--meta-cor) !important; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.btn-toggle:disabled { opacity: 0.4; cursor: not-allowed; }

.secao-parcelamento { margin-top: 5px; }
.checkbox-sutil { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.texto-check { color: var(--text-principal); font-weight: 500; font-size: 0.85rem; }
.opcoes-parcelamento { display: flex; gap: 18px; margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--input-border); }
.campo-pequeno { max-width: 120px; }

.btn-salvar-elegante { width: 100%; padding: 14px; color: white; border: none; border-radius: 6px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: 0.2s;}
.btn-salvar-elegante:disabled { opacity: 0.7; cursor: not-allowed; }
.btn-cor-receita { background-color: var(--receita); }
.btn-cor-receita:hover { background-color: #059669; }
.btn-cor-despesa { background-color: var(--primary); }
.btn-cor-despesa:hover { background-color: #2563eb; }
.btn-cor-transferencia { background-color: var(--transferencia); }
.btn-cor-transferencia:hover { background-color: #7c3aed; }
.btn-cor-meta { background-color: var(--meta-cor); }
.btn-cor-meta:hover { background-color: #0284c7; }

.btn-salvar-secundario { padding: 10px 20px; background-color: var(--primary); color: white; border: none; border-radius: 6px; font-weight: 500; font-size: 0.85rem; cursor: pointer; transition: 0.2s;}
.btn-salvar-secundario:hover { opacity: 0.9; }
.btn-salvar-secundario:disabled { opacity: 0.7; cursor: not-allowed; }
.btn-link { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: 0.2s;}
.btn-link:hover { color: var(--text-principal); }
.text-danger:hover { color: var(--despesa) !important; }
.btn-link-apagar { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.8rem; text-decoration: underline; }
.btn-link-apagar:hover { color: var(--despesa); }

.navegador-mes { display: flex; align-items: center; gap: 15px; background: var(--bg-cartao); padding: 6px 12px; border-radius: 6px; border: 1px solid var(--borda); }
.mes-display { font-weight: 600; font-size: 0.85rem; min-width: 120px; text-align: center; color: var(--text-principal); text-transform: uppercase; letter-spacing: 0.5px;}
.btn-seta { background: none; border: none; color: var(--text-muted); font-size: 1rem; cursor: pointer; padding: 0 5px; font-weight: bold; }
.btn-seta:hover { color: var(--primary); }

.tabela { width: 100%; border-collapse: collapse; }
.tabela th { text-transform: uppercase; font-size: 0.7rem; font-weight: 600; color: var(--text-muted); padding: 15px 10px; border-bottom: 1px solid var(--borda); text-align: left; letter-spacing: 0.5px;}
.tabela td { padding: 15px 10px; border-bottom: 1px solid var(--input-bg); font-size: 0.85rem; }
.centro { text-align: center; padding: 30px; }
.texto-verde { color: var(--receita); font-weight: 600; }
.texto-vermelho { font-weight: 600; }
.texto-roxo { color: var(--transferencia); font-weight: 600; }
.texto-azul { color: var(--meta-cor); font-weight: 600; }
.etiqueta-limpa { color: var(--text-muted); font-size: 0.8rem; }
.etiqueta-transf { color: var(--text-principal); font-size: 0.75rem; font-weight: 600; background: var(--input-bg); border: 1px solid var(--input-border); padding: 4px 8px; border-radius: 4px; }
.etiqueta-meta { color: var(--meta-cor); font-size: 0.75rem; font-weight: 600; background: rgba(14, 165, 233, 0.05); border: 1px solid rgba(14, 165, 233, 0.2); padding: 4px 8px; border-radius: 4px; }
.descricao-celula { display: flex; flex-direction: column; gap: 4px; }
.desc-texto { font-weight: 500; display: flex; align-items: center; gap: 8px;}
.etiqueta-pagamento { font-size: 0.65rem; color: var(--text-muted); background: var(--input-bg); padding: 2px 6px; border-radius: 3px; width: fit-content; text-transform: uppercase; font-weight: 600; border: 1px solid var(--input-border);}
.link-comprovante { text-decoration: none; font-size: 0.75rem; color: var(--primary); font-weight: 600; background: rgba(37, 99, 235, 0.05); padding: 2px 6px; border-radius: 4px;}
.link-comprovante:hover { background: rgba(37, 99, 235, 0.1); }

.em-linha { flex-direction: row; align-items: flex-end; }
.flex-grow { flex-grow: 1; }
.info-cat-header { display: flex; align-items: center; }
.etiqueta-limite { font-size: 0.7rem; background: var(--input-bg); padding: 4px 8px; border-radius: 4px; color: var(--text-muted); border: 1px solid var(--input-border); font-weight: 500;}
.etiqueta-limite.tem-limite { color: var(--primary); border-color: rgba(37, 99, 235, 0.2); background: rgba(37, 99, 235, 0.05); font-weight: 600; }

.cabecalho-categoria { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--input-bg); padding-bottom: 15px; margin-bottom: 15px; }
.titulo-categoria { margin: 0; font-size: 0.95rem; font-weight: 600; color: var(--text-principal); }
.acoes-categoria { display: flex; gap: 15px; }
.area-subcategorias { display: flex; flex-direction: column; gap: 12px; }
.etiquetas-subcategorias { display: flex; flex-wrap: wrap; gap: 8px; }
.etiqueta-sub { background: var(--input-bg); color: var(--text-principal); padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; display: flex; align-items: center; gap: 8px; border: 1px solid var(--input-border); }
.btn-fechar { background: none; border: none; color: var(--text-muted); padding: 0; font-size: 0.7rem; cursor: pointer; font-weight: bold; }
.btn-fechar:hover { color: var(--despesa); }
.form-subcategoria { display: flex; gap: 10px; }
.input-pequeno { padding: 8px 12px; font-size: 0.8rem; width: 250px; }
.btn-add-mini { padding: 8px 15px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 4px; color: var(--text-principal); cursor: pointer; font-weight: bold; transition: 0.2s;}
.btn-add-mini:hover { background: var(--borda); }

.animacao-entrada { animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
:global(body) { margin: 0; padding: 0; background-color: var(--bg-app); font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
</style>