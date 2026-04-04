<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc, updateDoc, getDocs, where, arrayUnion, limit } from 'firebase/firestore'
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage' 
import { db, auth, storage } from './firebase' 

import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler } from 'chart.js'
import { Doughnut, Line } from 'vue-chartjs'
import emailjs from '@emailjs/browser'
import confetti from 'canvas-confetti' 
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler)

// 0. ESTADO DE AUTENTICAÇÃO, FAMÍLIA E PLANO (NOVO)
const usuarioLogado = ref(null)
const carregandoAuth = ref(true)
const familiaAtual = ref(null) 

// NOVO: Controle do Plano (Free vs Premium)
const isPremiumPlano = ref(false)

let unsubTransacoes = null;
let unsubCategorias = null;
let unsubContas = null;
let unsubMetas = null;
let unsubDividas = null; 
let unsubAuditoria = null; 

const extrairNome = (email) => {
  if(!email) return '';
  const parte = email.split('@')[0];
  return parte.charAt(0).toUpperCase() + parte.slice(1);
};

const loginComGoogle = async () => {
  const provider = new GoogleAuthProvider();
  try { await signInWithPopup(auth, provider); } 
  catch (error) { 
    console.error(error);
    alert("Erro do Firebase: " + error.message); 
  }
}

const fazerLogout = async () => {
  if(confirm("Tem certeza que deseja sair?")) {
    await signOut(auth);
    window.location.reload(); 
  }
}

const isAdmin = computed(() => {
  if (!familiaAtual.value || !usuarioLogado.value) return false;
  const adminEmail = familiaAtual.value.admin || familiaAtual.value.membros[0];
  return adminEmail === usuarioLogado.value.email.toLowerCase();
});

const getColecao = (nomeColecao) => collection(doc(db, "familias", familiaAtual.value.id), nomeColecao);
const getDocRef = (nomeColecao, id) => doc(db, "familias", familiaAtual.value.id, nomeColecao, id);

// ==========================================
// REGISTRO DE AUDITORIA (LOGGER)
// ==========================================
const historicoAuditoria = ref([])

const registrarAuditoria = async (acao, detalhes) => {
  if (!familiaAtual.value || !usuarioLogado.value) return;
  try {
    await addDoc(getColecao("auditoria"), {
      dataHora: new Date().toISOString(),
      usuarioEmail: usuarioLogado.value.email,
      usuarioNome: usuarioLogado.value.displayName.split(' ')[0],
      acao: acao,
      detalhes: detalhes
    });
  } catch(e) {
    console.error("Erro ao gravar auditoria", e);
  }
}

const formatarDataHora = (isoString) => {
  if (!isoString) return '';
  const data = new Date(isoString);
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// 1. FUNÇÕES DE GESTÃO DA FAMÍLIA E CONVITE
const criarFamilia = async () => {
  try {
    const emailUser = usuarioLogado.value.email.toLowerCase();
    const docRef = await addDoc(collection(db, "familias"), {
      nome: `Família de ${usuarioLogado.value.displayName.split(' ')[0]}`,
      membros: [emailUser],
      admin: emailUser
    });
    familiaAtual.value = { id: docRef.id, nome: `Família de ${usuarioLogado.value.displayName.split(' ')[0]}`, membros: [emailUser], admin: emailUser };
    iniciarListenersDaFamilia(docRef.id);
    registrarAuditoria("Criou a Conta", "Ambiente familiar inicializado.");
    telaAtual.value = 'dashboard';
  } catch (e) {
    alert("Erro ao criar ambiente.");
  }
}

const emailConvite = ref('');
const statusEnvio = ref(''); 

const convidarMembro = async () => {
  if (!isAdmin.value) { alert("Apenas o administrador pode convidar."); return; }
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
    
    registrarAuditoria("Convidou Membro", `E-mail: ${emailFormatado}`);
    emailConvite.value = ''; statusEnvio.value = ''; alert(`Convite enviado com sucesso para ${emailFormatado}!`);
  } catch (e) { 
    console.error("Erro ao convidar: ", e); statusEnvio.value = '';
    alert("O membro foi adicionado, mas erro ao enviar e-mail."); 
  }
}

const removerMembro = async (emailParaRemover) => {
  if (!isAdmin.value) { alert("Apenas o administrador pode remover membros."); return; }
  if (emailParaRemover === usuarioLogado.value.email) { alert("Você não pode remover a si mesmo por aqui."); return; }
  if(confirm(`Remover o acesso de ${emailParaRemover}?`)) {
    const novosMembros = familiaAtual.value.membros.filter(e => e !== emailParaRemover);
    await updateDoc(doc(db, "familias", familiaAtual.value.id), { membros: novosMembros });
    familiaAtual.value.membros = novosMembros;
    registrarAuditoria("Removeu Membro", `E-mail revogado: ${emailParaRemover}`);
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
    const listaContas = []; qs.forEach((d) => listaContas.push({ id: d.id, nome: d.data().nome, tipo: d.data().tipo, limite: d.data().limite || 0, diaFechamento: d.data().diaFechamento || 31, diaVencimento: d.data().diaVencimento || 10 })); contasDisponiveis.value = listaContas;
  });
  unsubMetas = onSnapshot(query(collection(pastaFamilia, "metas"), orderBy("nome", "asc")), (qs) => {
    const listaM = []; qs.forEach((d) => listaM.push({ id: d.id, ...d.data() })); metas.value = listaM;
  });
  unsubDividas = onSnapshot(query(collection(pastaFamilia, "dividasFixas"), orderBy("diaVencimento", "asc")), (qs) => {
    const listaD = []; qs.forEach((d) => listaD.push({ id: d.id, ...d.data() })); dividasFixas.value = listaD;
  });
  unsubAuditoria = onSnapshot(query(collection(pastaFamilia, "auditoria"), orderBy("dataHora", "desc"), limit(100)), (qs) => {
    const listaA = []; qs.forEach((d) => listaA.push({ id: d.id, ...d.data() })); historicoAuditoria.value = listaA;
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


// ==========================================
// DÍVIDAS E DESPESAS FIXAS
// ==========================================
const dividasFixas = ref([])
const novaDividaNome = ref('')
const novaDividaValor = ref('')
const novaDividaDia = ref(10)
const dividaCategoria = ref('')
const dividaSubcategoria = ref('')

const subcategoriasDividaDropdown = computed(() => {
  const cat = categoriasDisponiveis.value.find(c => c.nome === dividaCategoria.value);
  return cat ? cat.subcategorias : [];
});
watch(dividaCategoria, () => {
  if (subcategoriasDividaDropdown.value.length > 0) dividaSubcategoria.value = subcategoriasDividaDropdown.value[0]; 
  else dividaSubcategoria.value = ''; 
});

const adicionarDividaFixa = async () => {
  if (!novaDividaNome.value || !novaDividaValor.value || !dividaCategoria.value) return;
  try {
    await addDoc(getColecao("dividasFixas"), { 
      nome: novaDividaNome.value.trim(), valor: parseFloat(novaDividaValor.value), diaVencimento: parseInt(novaDividaDia.value),
      categoria: dividaCategoria.value, subcategoria: dividaSubcategoria.value || '', pagamentos: [] 
    });
    registrarAuditoria("Criou Despesa Fixa", `${novaDividaNome.value} - ${formatarMoeda(novaDividaValor.value)}`);
    novaDividaNome.value = ''; novaDividaValor.value = ''; novaDividaDia.value = 10;
  } catch(e) { alert("Erro ao criar despesa fixa."); }
}

const removerDividaFixa = async (id) => { 
  const d = dividasFixas.value.find(x => x.id === id);
  if(confirm("Excluir esta despesa fixa? Os lançamentos antigos não serão apagados.")) {
    await deleteDoc(getDocRef("dividasFixas", id));
    if (d) registrarAuditoria("Apagou Despesa Fixa", d.nome);
  }
}

const editarValorDivida = async (divida) => {
  const novoValorStr = prompt(`Novo valor base para ${divida.nome} (R$):`, divida.valor);
  if (!novoValorStr) return;
  const novoValor = parseFloat(novoValorStr.replace(',', '.'));
  if (novoValor > 0) {
    await updateDoc(getDocRef("dividasFixas", divida.id), { valor: novoValor });
    registrarAuditoria("Alterou Valor Fixo", `${divida.nome} alterado para ${formatarMoeda(novoValor)}`);
  }
}

const dividaSendoPaga = ref(null); 
const iniciarPagamentoFixo = (divida) => {
  telaAtual.value = 'lancamentos';
  mostrarFormulario.value = true;
  tipo.value = 'despesa';
  descricao.value = `Pagamento: ${divida.nome}`;
  valor.value = divida.valor;
  categoriaSelecionada.value = divida.categoria;
  subcategoriaSelecionada.value = divida.subcategoria || '';
  responsavel.value = usuarioLogado.value.email.toLowerCase(); 
  
  const hj = new Date();
  dataLancamento.value = `${hj.getFullYear()}-${String(hj.getMonth() + 1).padStart(2, '0')}-${String(divida.diaVencimento).padStart(2, '0')}`;
  dividaSendoPaga.value = divida.id; 
}

const contasVencendo = computed(() => {
  if (!isPremiumPlano.value) return []; // Desativa o alerta no plano free
  const hj = new Date();
  const diaAtual = hj.getDate();
  const mesAnoAtual = hj.toISOString().slice(0, 7); 
  return dividasFixas.value
    .filter(d => !d.pagamentos || !d.pagamentos.includes(mesAnoAtual)) 
    .map(d => {
      const diasRestantes = d.diaVencimento - diaAtual;
      let status = ''; let corClass = '';
      if (diasRestantes < 0) { status = 'Atrasado!'; corClass = 'texto-vermelho'; }
      else if (diasRestantes === 0) { status = 'Vence HOJE!'; corClass = 'texto-vermelho'; }
      else if (diasRestantes <= 3) { status = `Vence em ${diasRestantes} dias`; corClass = 'texto-laranja'; }
      else { status = `Dia ${d.diaVencimento}`; corClass = 'text-muted'; }
      return { ...d, diasRestantes, status, corClass };
    }).filter(d => d.diasRestantes <= 3).sort((a, b) => a.diasRestantes - b.diasRestantes);
});


// 4. ESTADO DAS METAS E ATALHO DE APORTE
const metas = ref([])
const novaMetaNome = ref('')
const novaMetaObjetivo = ref('')
const novaMetaAtual = ref('')
const metasPendentes = computed(() => metas.value.filter(m => m.valorAtual < m.valorObjetivo));

const adicionarMeta = async () => {
  if (!novaMetaNome.value || !novaMetaObjetivo.value) return;
  const objetivo = parseFloat(novaMetaObjetivo.value);
  if (objetivo <= 0) return;
  try {
    await addDoc(getColecao("metas"), { nome: novaMetaNome.value.trim(), valorObjetivo: objetivo, valorAtual: parseFloat(novaMetaAtual.value || 0) });
    registrarAuditoria("Criou Meta", `${novaMetaNome.value.trim()} - Objetivo: ${formatarMoeda(objetivo)}`);
    novaMetaNome.value = ''; novaMetaObjetivo.value = ''; novaMetaAtual.value = '';
  } catch(e) { alert("Erro ao criar meta."); }
}
const removerMeta = async (id) => { 
  const m = metas.value.find(x => x.id === id);
  if(confirm("Excluir esta meta?")) {
    await deleteDoc(getDocRef("metas", id));
    if (m) registrarAuditoria("Apagou Meta", m.nome);
  }
}
const iniciarAporte = (meta) => {
  telaAtual.value = 'lancamentos'; mostrarFormulario.value = true; tipo.value = 'meta'; metaSelecionada.value = meta.id;
  responsavel.value = usuarioLogado.value.email.toLowerCase(); descricao.value = `Aporte: ${meta.nome}`;
}

// 5. ESTADO DAS CONTAS E CATEGORIAS 
const contasDisponiveis = ref([])
const novaContaNome = ref('')
const novaContaTipo = ref('Conta Bancária')
const novoCartaoLimite = ref('')
const novoCartaoFechamento = ref(1)
const novoCartaoVencimento = ref(10)

const adicionarConta = async () => {
  if (!novaContaNome.value) return;
  const existe = contasDisponiveis.value.find(c => c.nome.toLowerCase() === novaContaNome.value.toLowerCase());
  if (!existe) {
    try {
      const objConta = { nome: novaContaNome.value.trim(), tipo: novaContaTipo.value };
      if (novaContaTipo.value === 'Cartão de Crédito' && isPremiumPlano.value) {
        objConta.limite = parseFloat(novoCartaoLimite.value) || 0;
        objConta.diaFechamento = parseInt(novoCartaoFechamento.value) || 1;
        objConta.diaVencimento = parseInt(novoCartaoVencimento.value) || 10;
      }
      await addDoc(getColecao("contas"), objConta);
      registrarAuditoria("Adicionou Conta", `${objConta.nome} (${objConta.tipo})`);
      novaContaNome.value = ''; novoCartaoLimite.value = ''; novoCartaoFechamento.value = 1; novoCartaoVencimento.value = 10;
    } catch (e) {}
  } else alert("Conta/cartão já existe.");
}
const removerConta = async (id) => { 
  const c = contasDisponiveis.value.find(x => x.id === id);
  await deleteDoc(getDocRef("contas", id)); 
  if (c) registrarAuditoria("Apagou Conta", c.nome);
}
const editarConta = async (conta) => {
  const novoNome = prompt("Novo nome:", conta.nome);
  if (!novoNome || novoNome.trim() === "" || novoNome === conta.nome) return;
  try {
    await updateDoc(getDocRef("contas", conta.id), { nome: novoNome.trim() });
    registrarAuditoria("Renomeou Conta", `De '${conta.nome}' para '${novoNome.trim()}'`);
    const qs = await getDocs(query(getColecao("transacoes"), where("conta", "==", conta.nome)));
    qs.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { conta: novoNome.trim() }));
    const qsDestino = await getDocs(query(getColecao("transacoes"), where("contaDestino", "==", conta.nome)));
    qsDestino.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { contaDestino: novoNome.trim() }));
  } catch (e) {}
}

const categoriasDisponiveis = ref([]) 
const novaCategoria = ref('')
const inputsSubcategoria = ref({}) 
const adicionarCategoria = async () => {
  if (!novaCategoria.value) return;
  try { 
    await addDoc(getColecao("categorias"), { nome: novaCategoria.value.trim(), subcategorias: [], limiteMensal: 0 }); 
    registrarAuditoria("Adicionou Categoria", novaCategoria.value.trim());
    novaCategoria.value = ''; 
  } catch (e) {}
}
const removerCategoria = async (id) => { 
  const c = categoriasDisponiveis.value.find(x => x.id === id);
  await deleteDoc(getDocRef("categorias", id)); 
  if (c) registrarAuditoria("Apagou Categoria", c.nome);
}
const definirLimite = async (categoria) => {
  const limiteStr = prompt(`Limite mensal para "${categoria.nome}" (R$):`, categoria.limiteMensal || '');
  if (limiteStr === null) return; 
  const novoLim = parseFloat(limiteStr.replace(',', '.')) || 0;
  await updateDoc(getDocRef("categorias", categoria.id), { limiteMensal: novoLim });
  registrarAuditoria("Alterou Limite de Categoria", `${categoria.nome} - Novo Teto: ${formatarMoeda(novoLim)}`);
}
const adicionarSubcategoria = async (categoria) => {
  const novaSub = inputsSubcategoria.value[categoria.id];
  if (!novaSub) return;
  await updateDoc(getDocRef("categorias", categoria.id), { subcategorias: [...categoria.subcategorias, novaSub] });
  inputsSubcategoria.value[categoria.id] = ''; 
}
const removerSubcategoria = async (categoria, subRemover) => {
  await updateDoc(getDocRef("categorias", categoria.id), { subcategorias: categoria.subcategorias.filter(s => s !== subRemover) });
}

// ==========================================
// GESTÃO DE CARTÕES DE CRÉDITO
// ==========================================
const cartoesCadastrados = computed(() => contasDisponiveis.value.filter(c => c.tipo === 'Cartão de Crédito'));
const outrasContasCadastradas = computed(() => contasDisponiveis.value.filter(c => c.tipo !== 'Cartão de Crédito'));

const getCartaoStatusGlobal = (cartao) => {
  let totalGasto = 0; let totalPago = 0;
  transacoes.value.forEach(t => {
    if (t.conta === cartao.nome && t.tipo === 'despesa') totalGasto += t.valor;
    if (t.contaDestino === cartao.nome && t.tipo === 'transferencia') totalPago += t.valor;
  });
  const limiteDisponivel = (cartao.limite || 0) - (totalGasto - totalPago);
  return { limiteDisponivel, limiteTotal: cartao.limite || 0 };
};

const calcularDataFatura = (dataCompra, fechamento, vencimento, parcelasAdicionais) => {
  let [ano, mes, dia] = dataCompra.split('-').map(Number);
  let mesFatura = mes; let anoFatura = ano;
  if (dia >= fechamento) { mesFatura++; if (mesFatura > 12) { mesFatura = 1; anoFatura++; } }
  mesFatura += parcelasAdicionais;
  while (mesFatura > 12) { mesFatura -= 12; anoFatura++; }
  let mesVencimento = mesFatura; let anoVencimento = anoFatura;
  if (vencimento < fechamento) { mesVencimento++; if (mesVencimento > 12) { mesVencimento = 1; anoVencimento++; } }
  return `${anoVencimento}-${String(mesVencimento).padStart(2, '0')}-${String(vencimento).padStart(2, '0')}`;
}

const getFaturaDetalhada = (cartao, mesYMD) => {
  let [ano, mes] = mesYMD.split('-').map(Number);
  let fechamento = cartao.diaFechamento || 31;
  let dataFechamentoAtual = new Date(ano, mes - 1, fechamento);
  let strFechamentoAtual = `${dataFechamentoAtual.getFullYear()}-${String(dataFechamentoAtual.getMonth() + 1).padStart(2, '0')}-${String(dataFechamentoAtual.getDate()).padStart(2, '0')}`;

  let totalFatura = 0; let transacoesFatura = [];
  transacoes.value.forEach(t => {
    if (t.conta === cartao.nome && t.tipo === 'despesa' && t.data && t.data.startsWith(mesYMD)) {
      totalFatura += t.valor; transacoesFatura.push(t);
    }
  });

  let totalPago = 0;
  transacoes.value.forEach(t => {
    if (t.tipo === 'transferencia' && t.contaDestino === cartao.nome && t.faturaMes === mesYMD) totalPago += t.valor;
  });

  const hojeStr = new Date().toISOString().slice(0, 10);
  const isFechada = hojeStr > strFechamentoAtual;
  const pagoEfetivo = Math.round(totalPago * 100);
  const faturaEfetiva = Math.round(totalFatura * 100);

  return { 
    total: totalFatura, 
    transacoes: transacoesFatura.sort((a, b) => ((a.dataCompra || a.data) || '').localeCompare((b.dataCompra || b.data) || '')), 
    pago: pagoEfetivo >= faturaEfetiva && faturaEfetiva > 0,
    valorPago: totalPago,
    isFechada: isFechada,
    dataFechamento: strFechamentoAtual
  };
};

const modalPagarFatura = ref(false);
const cartaoAlvoPagamento = ref(null);
const valorFaturaPagamento = ref(0);
const contaOrigemPagamentoFatura = ref('');

const iniciarPagamentoFatura = (cartao, valor) => {
  cartaoAlvoPagamento.value = cartao;
  valorFaturaPagamento.value = Number(valor.toFixed(2));
  modalPagarFatura.value = true;
};

const confirmarPagamentoFatura = async () => {
  if (!contaOrigemPagamentoFatura.value) { alert("Selecione a conta de origem!"); return; }
  try {
    const hj = new Date().toISOString().slice(0, 10);
    await addDoc(getColecao("transacoes"), { 
      tipo: 'transferencia', descricao: `Pagamento Fatura ${mesFormatado.value}`, 
      responsavel: usuarioLogado.value.email.toLowerCase(), beneficiario: usuarioLogado.value.email.toLowerCase(),
      conta: contaOrigemPagamentoFatura.value, contaDestino: cartaoAlvoPagamento.value.nome,
      data: hj, valor: valorFaturaPagamento.value, faturaMes: mesFiltro.value 
    });
    
    registrarAuditoria("Pagou Fatura", `${cartaoAlvoPagamento.value.nome} (${mesFormatado.value}) - Valor: ${formatarMoeda(valorFaturaPagamento.value)}`);
    modalPagarFatura.value = false; contaOrigemPagamentoFatura.value = '';
    alert("Fatura paga com sucesso! Seu limite foi restabelecido.");
  } catch(e) { alert("Erro ao processar pagamento."); }
};


// 6. ESTADO DOS LANÇAMENTOS E UPLOAD NO FIREBASE
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

const inputComprovanteOculto = ref(null);
const transacaoAlvoAnexo = ref(null);
const uploadingId = ref(null);

const abrirSeletorArquivo = (t) => { transacaoAlvoAnexo.value = t; if (inputComprovanteOculto.value) inputComprovanteOculto.value.click(); };
const processarAnexoPosterior = async (event) => {
  const arquivo = event.target.files[0];
  if (!arquivo || !transacaoAlvoAnexo.value) return;
  const t = transacaoAlvoAnexo.value; uploadingId.value = t.id;
  try {
    const nomeArquivo = `${Date.now()}_${arquivo.name}`;
    const caminho = `familias/${familiaAtual.value.id}/comprovantes/${nomeArquivo}`;
    const arquivoRef = storageRef(storage, caminho);
    await uploadBytes(arquivoRef, arquivo);
    const url = await getDownloadURL(arquivoRef);
    await updateDoc(getDocRef("transacoes", t.id), { comprovanteUrl: url, comprovanteCaminho: caminho });
    registrarAuditoria("Anexou Comprovante", `Em transação: ${t.descricao}`);
  } catch (err) { alert("Erro ao enviar anexo."); } 
  finally { uploadingId.value = null; transacaoAlvoAnexo.value = null; event.target.value = ''; }
};

const subcategoriasDropdown = computed(() => {
  const cat = categoriasDisponiveis.value.find(c => c.nome === categoriaSelecionada.value);
  return cat ? cat.subcategorias : [];
});

const isContaCartaoSelecionada = computed(() => {
  const c = contasDisponiveis.value.find(x => x.nome === contaSelecionada.value);
  return c && c.tipo === 'Cartão de Crédito';
});

watch(categoriaSelecionada, () => {
  if (subcategoriasDropdown.value.length > 0) subcategoriaSelecionada.value = subcategoriasDropdown.value[0]; 
  else subcategoriaSelecionada.value = ''; 
});
watch(categoriasDisponiveis, (novaLista) => {
  if (novaLista.length > 0 && (!categoriaSelecionada.value || !novaLista.find(c => c.nome === categoriaSelecionada.value))) categoriaSelecionada.value = novaLista[0].nome;
});
watch(contasDisponiveis, (novaLista) => {
  if (novaLista.length > 0) {
    if(!contaSelecionada.value || !novaLista.find(c => c.nome === contaSelecionada.value)) contaSelecionada.value = novaLista[0].nome;
    if(!contaDestinoSelecionada.value || !novaLista.find(c => c.nome === contaDestinoSelecionada.value)) contaDestinoSelecionada.value = novaLista[0].nome;
  }
});
watch(tipo, (novoTipo) => { if (novoTipo === 'meta') isParcelado.value = false; });

const calcularDataFutura = (dataBase, meses) => {
  const [a, m, d] = dataBase.split('-');
  const dt = new Date(a, m - 1, d);
  const diaOrig = dt.getDate();
  dt.setMonth(dt.getMonth() + meses);
  if (dt.getDate() !== diaOrig) dt.setDate(0); 
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const soltarConfetes = () => { confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#10b981', '#3b82f6', '#f59e0b'], zIndex: 9999 }); };
const selecionarArquivo = (event) => { arquivoComprovante.value = event.target.files[0]; };

const adicionarTransacao = async () => {
  if (!descricao.value || !valor.value || !dataLancamento.value || !contaSelecionada.value || !responsavel.value) {
    alert("Preencha todos os campos obrigatórios."); return;
  }
  
  const valBase = parseFloat(valor.value);
  const descLog = descricao.value; 
  const tipoLog = tipo.value;
  
  const contaObj = contasDisponiveis.value.find(c => c.nome === contaSelecionada.value);
  const isCC = contaObj && contaObj.tipo === 'Cartão de Crédito';

  if (isCC && tipo.value === 'despesa') {
    const statusGlobal = getCartaoStatusGlobal(contaObj);
    if (valBase > statusGlobal.limiteDisponivel) {
      if(!confirm(`Atenção: Esta compra ultrapassa o limite disponível do seu cartão (${formatarMoeda(statusGlobal.limiteDisponivel)}). Deseja forçar o lançamento mesmo assim?`)) return;
    }
  }
  
  try {
    const transacaoObj = { tipo: tipo.value, descricao: descricao.value, responsavel: responsavel.value, conta: contaSelecionada.value };
    
    let urlDoArquivo = ''; let caminhoFisicoNoStorage = ''; 
    if (arquivoComprovante.value && isPremiumPlano.value) {
      uploadProgresso.value = true;
      try {
        const nomeArquivo = `${Date.now()}_${arquivoComprovante.value.name}`;
        caminhoFisicoNoStorage = `familias/${familiaAtual.value.id}/comprovantes/${nomeArquivo}`;
        const arquivoRef = storageRef(storage, caminhoFisicoNoStorage);
        await uploadBytes(arquivoRef, arquivoComprovante.value);
        urlDoArquivo = await getDownloadURL(arquivoRef);
      } catch (err) { console.error(err); alert("Erro no Storage."); }
      uploadProgresso.value = false;
    }
    if (urlDoArquivo) { transacaoObj.comprovanteUrl = urlDoArquivo; transacaoObj.comprovanteCaminho = caminhoFisicoNoStorage; }

    if (tipo.value === 'meta') {
      let valorRestante = valBase;
      let indiceAtual = metasPendentes.value.findIndex(m => m.id === metaSelecionada.value);
      if (indiceAtual === -1) indiceAtual = 0; 
      if (metasPendentes.value.length === 0) { alert("Metas atingidas!"); return; }

      while (valorRestante > 0 && indiceAtual < metasPendentes.value.length) {
        const metaCorrente = metasPendentes.value[indiceAtual];
        const falta = metaCorrente.valorObjetivo - metaCorrente.valorAtual;
        
        if (falta > 0) {
          const aporte = Math.min(valorRestante, falta);
          await addDoc(getColecao("transacoes"), { ...transacaoObj, data: dataLancamento.value, valor: aporte, metaId: metaCorrente.id, nomeMeta: metaCorrente.nome });
          await updateDoc(getDocRef("metas", metaCorrente.id), { valorAtual: metaCorrente.valorAtual + aporte });
          if (aporte === falta) soltarConfetes();
          valorRestante -= aporte;
        }
        if (valorRestante > 0) indiceAtual++;
      }

    } else {
      if (tipo.value === 'transferencia') { transacaoObj.beneficiario = beneficiario.value; transacaoObj.contaDestino = contaDestinoSelecionada.value; } 
      else { transacaoObj.categoria = categoriaSelecionada.value; transacaoObj.subcategoria = subcategoriaSelecionada.value || ''; }

      if (isParcelado.value) {
        const qtd = parseInt(numeroParcelas.value);
        let shiftFatura = 0;
        if (isCC) {
            let dataPrimeiraFatura = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, 0);
            const faturaPrimeira = getFaturaDetalhada(contaObj, dataPrimeiraFatura.slice(0,7));
            if (faturaPrimeira.pago) shiftFatura = 1;
        }

        for (let i = 0; i < qtd; i++) {
          let dataParcela = calcularDataFutura(dataPrimeiraParcela.value, i);
          if (isCC) dataParcela = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, i + shiftFatura);
          
          await addDoc(getColecao("transacoes"), { 
            ...transacaoObj, descricao: `${descricao.value} (${i + 1}/${qtd})`, valor: valBase / qtd, data: dataParcela, dataCompra: dataLancamento.value 
          });
        }
      } else {
        let dataRegistro = dataLancamento.value;
        if (isCC) {
          dataRegistro = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, 0);
          const faturaDestino = getFaturaDetalhada(contaObj, dataRegistro.slice(0,7));
          if (faturaDestino.pago) dataRegistro = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, 1);
        }
        await addDoc(getColecao("transacoes"), { ...transacaoObj, valor: valBase, data: dataRegistro, dataCompra: dataLancamento.value });
      }
    }
    
    if (dividaSendoPaga.value) {
      const mesRegistro = dataLancamento.value.slice(0, 7); 
      await updateDoc(getDocRef("dividasFixas", dividaSendoPaga.value), { pagamentos: arrayUnion(mesRegistro) });
      dividaSendoPaga.value = null; 
    }

    registrarAuditoria("Novo Registro", `${tipoLog.toUpperCase()}: ${descLog} - Valor: ${formatarMoeda(valBase)}`);

    descricao.value = ''; valor.value = ''; isParcelado.value = false; numeroParcelas.value = 2; arquivoComprovante.value = null;
    if(document.getElementById("input-comprovante")) document.getElementById("input-comprovante").value = "";
    mostrarFormulario.value = false; 

  } catch (e) { 
    console.error("ERRO COMPLETO:", e);
    alert("Falha no processo de gravação: " + e.message); 
    uploadProgresso.value = false; 
  }
}

const apagarTransacao = async (t) => { 
  if (confirm("Apagar registro permanentemente?")) {
    await deleteDoc(getDocRef("transacoes", t.id));
    if (t.comprovanteUrl && t.comprovanteCaminho) { try { await deleteObject(storageRef(storage, t.comprovanteCaminho)); } catch (err) {} }
    if (t.tipo === 'meta') {
      const metaObj = metas.value.find(m => m.id === t.metaId);
      if (metaObj) await updateDoc(getDocRef("metas", metaObj.id), { valorAtual: metaObj.valorAtual - t.valor });
    }
    registrarAuditoria("Apagou Registro", `${t.tipo.toUpperCase()}: ${t.descricao} - Valor: ${formatarMoeda(t.valor)}`);
  }
}

// ==========================================
// EXPORTAÇÃO, DASHBOARD, PROJEÇÃO E DRE 
// ==========================================
const receitaMediaGeral = computed(() => {
  const hj = new Date();
  let totalRec = 0; let mesesC = 0;
  for (let i = 1; i <= 3; i++) {
    let m = new Date(hj.getFullYear(), hj.getMonth() - i, 1);
    let prefix = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    let rec = transacoes.value.filter(t => t.tipo === 'receita' && t.data && t.data.startsWith(prefix)).reduce((a, b) => a + b.valor, 0);
    if (rec > 0) { totalRec += rec; mesesC++; }
  }
  if (mesesC === 0) {
     let prefixHj = `${hj.getFullYear()}-${String(hj.getMonth() + 1).padStart(2, '0')}`;
     return transacoes.value.filter(t => t.tipo === 'receita' && t.data && t.data.startsWith(prefixHj)).reduce((a, b) => a + b.valor, 0);
  }
  return totalRec / mesesC;
});

const saldoGeralReal = computed(() => {
  let totalRec = 0; let totalDesp = 0;
  const dataHojeStr = new Date().toISOString().slice(0, 10);
  transacoes.value.filter(t => t.data <= dataHojeStr).forEach(t => {
    if(t.tipo === 'receita') totalRec += t.valor;
    if(t.tipo === 'despesa' || t.tipo === 'meta') totalDesp += t.valor;
  });
  return totalRec - totalDesp;
});

const dadosProjecao = computed(() => {
  let saldoBase = saldoGeralReal.value;
  const recMedia = receitaMediaGeral.value || 0;
  const despesasFixasSoma = dividasFixas.value.reduce((a,b) => a + b.valor, 0);

  const dados = []; let dataCorrente = new Date();
  for (let i = 1; i <= 6; i++) {
    let m = new Date(dataCorrente.getFullYear(), dataCorrente.getMonth() + i, 1);
    let prefix = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    let nomeMesAno = m.toLocaleString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '');
    let parcelasPrevistas = transacoes.value.filter(t => t.data && t.data.startsWith(prefix) && (t.tipo === 'despesa' || t.tipo === 'meta')).reduce((a, b) => a + b.valor, 0);

    saldoBase = saldoBase + recMedia - despesasFixasSoma - parcelasPrevistas;
    dados.push({ mes: nomeMesAno.charAt(0).toUpperCase() + nomeMesAno.slice(1), prefix: prefix, receitaMedia: recMedia, fixas: despesasFixasSoma, parcelas: parcelasPrevistas, saldoPrevisto: saldoBase });
  }
  return dados;
});

const chartDataProjecao = computed(() => {
  return {
    labels: dadosProjecao.value.map(d => d.mes),
    datasets: [{
      label: 'Saldo Acumulado (Previsto)', data: dadosProjecao.value.map(d => d.saldoPrevisto), borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.4, pointRadius: 5, pointBorderColor: '#fff',
      pointBackgroundColor: dadosProjecao.value.map(d => d.saldoPrevisto >= 0 ? '#10b981' : '#ef4444')
    }]
  }
});

const chartOptionsProjecao = computed(() => ({ 
  responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(context) { return formatarMoeda(context.raw); } } } },
  scales: { y: { ticks: { callback: function(value) { return 'R$ ' + value; } } } }
}));

const transacoesFiltradas = computed(() => {
  if (!mesFiltro.value) return transacoes.value;
  return transacoes.value.filter(t => t.data && t.data.startsWith(mesFiltro.value));
});

const transacoesVisiveisTabela = computed(() => {
  return transacoesFiltradas.value.filter(t => {
    const conta = contasDisponiveis.value.find(c => c.nome === t.conta);
    return !(conta && conta.tipo === 'Cartão de Crédito'); 
  });
});

const ultimasComprasCartao = computed(() => {
  const nomesCartoes = contasDisponiveis.value.filter(c => c.tipo === 'Cartão de Crédito').map(c => c.nome);
  return transacoes.value
    .filter(t => t.tipo === 'despesa' && nomesCartoes.includes(t.conta))
    .sort((a, b) => ((b.dataCompra || b.data) || '').localeCompare((a.dataCompra || a.data) || ''))
    .slice(0, 5); 
});

const exportarCSV = () => {
  if (transacoesFiltradas.value.length === 0) { alert("Nenhum dado."); return; }
  let csv = 'Data;Descrição;Categoria/Meta;Conta Origem;Conta Destino;Responsável;Beneficiário;Tipo;Valor\n';
  transacoesFiltradas.value.forEach(t => {
    csv += `${formatarData(t.dataCompra || t.data)};${t.descricao.replace(/;/g, ',')};${t.tipo === 'meta' ? 'Meta: '+t.nomeMeta : t.categoria};${t.conta};${t.contaDestino||''};${extrairNome(t.responsavel)};${extrairNome(t.beneficiario)};${t.tipo.toUpperCase()};${t.valor.toString().replace('.', ',')}\n`;
  });
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' }));
  link.download = `HomeManager_${mesFiltro.value}.csv`; link.click();
  registrarAuditoria("Exportou Dados", `Formato CSV do mês ${mesFiltro.value}`);
};

const exportarPDF = () => {
  if (transacoesFiltradas.value.length === 0) { alert("Nenhum dado."); return; }
  const doc = new jsPDF(); doc.setFontSize(16); doc.text(`Relatório: ${mesFormatado.value}`, 14, 20);
  const rows = transacoesFiltradas.value.map(t => [ formatarData(t.dataCompra || t.data), t.descricao, t.tipo === 'meta' ? `Meta: ${t.nomeMeta}` : t.categoria, t.conta, extrairNome(t.responsavel), `${t.tipo === 'despesa' ? '-' : '+'} ${formatarMoeda(t.valor)}` ]);
  autoTable(doc, { head: [["Data", "Descrição", "Categoria", "Conta", "Resp.", "Valor"]], body: rows, startY: 30, theme: 'striped', styles: { fontSize: 8 }, headStyles: { fillColor: [37, 99, 235] } });
  doc.save(`HomeManager_${mesFiltro.value}.pdf`);
  registrarAuditoria("Exportou Dados", `Formato PDF do mês ${mesFiltro.value}`);
};

const transacoesAcumuladasAteMes = computed(() => {
  if (!mesFiltro.value) return transacoes.value;
  return transacoes.value.filter(t => t.data <= mesFiltro.value + '-31');
});

const despesasMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'despesa'));
const receitasMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'receita'));
const aportesMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'meta')); 

const totalReceitas = computed(() => receitasMes.value.reduce((a, t) => a + t.valor, 0));
const totalDespesas = computed(() => despesasMes.value.reduce((a, t) => a + t.valor, 0));
const totalAportes = computed(() => aportesMes.value.reduce((a, t) => a + t.valor, 0)); 
const saldoAtualMes = computed(() => totalReceitas.value - totalDespesas.value - totalAportes.value);

const orcamentosStatus = computed(() => {
  const gastosPorCategoria = {};
  despesasMes.value.forEach(t => { gastosPorCategoria[t.categoria] = (gastosPorCategoria[t.categoria] || 0) + t.valor; });
  return categoriasDisponiveis.value.filter(c => c.limiteMensal && c.limiteMensal > 0).map(c => {
      const gasto = gastosPorCategoria[c.nome] || 0;
      const pct = (gasto / c.limiteMensal) * 100;
      return { nome: c.nome, limite: c.limiteMensal, gasto: gasto, percentual: pct, cor: pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981' };
    }).sort((a, b) => b.percentual - a.percentual); 
});

const chartData = computed(() => {
  const totais = {};
  despesasMes.value.forEach(t => { totais[t.categoria] = (totais[t.categoria] || 0) + t.valor; });
  if (totalAportes.value > 0) totais['🎯 Guardado (Metas)'] = totalAportes.value;
  return { labels: Object.keys(totais), datasets: [{ data: Object.values(totais), backgroundColor: ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#64748b', '#10b981'], borderWidth: 0 }] }
});
const chartOptions = computed(() => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: temaEscuro.value ? '#cbd5e1' : '#334155', font: { size: 11 } } } } }));

const anoDRE = ref(new Date().getFullYear().toString());
const alterarAnoDRE = (delta) => { anoDRE.value = (parseInt(anoDRE.value) + delta).toString(); };
const mesesCurtos = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const matrizDRE = computed(() => {
  const estrutura = { receitas: Array(12).fill(0), categorias: {}, metas: Array(12).fill(0), totalDespesas: Array(12).fill(0), saldo: Array(12).fill(0) };
  categoriasDisponiveis.value.forEach(c => { estrutura.categorias[c.nome] = Array(12).fill(0); });
  
  transacoes.value.filter(t => (t.dataCompra || t.data) && (t.dataCompra || t.data).startsWith(anoDRE.value)).forEach(t => {
     if (t.tipo === 'despesa' && t.categoria && !estrutura.categorias[t.categoria]) estrutura.categorias[t.categoria] = Array(12).fill(0);
  });

  transacoes.value.forEach(t => {
    const dataUsada = t.dataCompra || t.data; 
    if (!dataUsada || !dataUsada.startsWith(anoDRE.value)) return;
    const mesIdx = parseInt(dataUsada.split('-')[1]) - 1;
    if (t.tipo === 'receita') estrutura.receitas[mesIdx] += t.valor;
    else if (t.tipo === 'despesa') {
      if(estrutura.categorias[t.categoria]) { estrutura.categorias[t.categoria][mesIdx] += t.valor; estrutura.totalDespesas[mesIdx] += t.valor; }
    } else if (t.tipo === 'meta') estrutura.metas[mesIdx] += t.valor;
  });

  for (let i = 0; i < 12; i++) estrutura.saldo[i] = estrutura.receitas[i] - estrutura.totalDespesas[i] - estrutura.metas[i];

  const listaCategorias = Object.keys(estrutura.categorias).map(cat => {
    const valores = estrutura.categorias[cat]; const total = valores.reduce((a,b) => a+b, 0); const media = total / 12; 
    return { nome: cat, valores, total, media };
  }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);

  const totaisAno = {
    receitas: estrutura.receitas.reduce((a,b)=>a+b, 0), despesas: estrutura.totalDespesas.reduce((a,b)=>a+b, 0),
    metas: estrutura.metas.reduce((a,b)=>a+b, 0), saldo: estrutura.saldo.reduce((a,b)=>a+b, 0)
  };

  return { ...estrutura, listaCategorias, totaisAno };
});


onMounted(() => {
  onAuthStateChanged(auth, async (user) => {
    usuarioLogado.value = user;
    if (user) {
      responsavel.value = user.email.toLowerCase(); 
      const qFamilia = query(collection(db, "familias"), where("membros", "array-contains", user.email.toLowerCase()));
      const querySnapshot = await getDocs(qFamilia);
      if (!querySnapshot.empty) {
        familiaAtual.value = { id: querySnapshot.docs[0].id, ...querySnapshot.docs[0].data() };
        iniciarListenersDaFamilia(familiaAtual.value.id);
        telaAtual.value = 'dashboard';
      } else telaAtual.value = 'sem_familia';
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
      <button @click="loginComGoogle" class="btn-google">Entrar com Google</button>
    </div>
  </div>

  <div v-else-if="telaAtual === 'sem_familia'" class="tela-login">
    <div class="login-card animacao-entrada" style="max-width: 500px;">
      <div class="logo-login"><h2>Bem-vindo!</h2></div>
      <button @click="criarFamilia" class="btn-salvar-elegante mt-10 mb-20">Criar Minha Família</button>
      <button @click="fazerLogout" class="btn-link text-danger">Sair da Conta</button>
    </div>
  </div>

  <div v-else class="app-layout" :class="temaEscuro ? 'tema-escuro' : 'tema-claro'">
    
    <aside class="sidebar">
      <div class="logo">
        <h2>HomeManager</h2>
        <div class="perfil-card">
          <img :src="usuarioLogado.photoURL" class="avatar-google" referrerpolicy="no-referrer" />
          <div class="perfil-info">
            <span class="nome-usuario">
              {{ usuarioLogado.displayName.split(' ')[0] }}
              <span :class="isPremiumPlano ? 'tag-pro' : 'tag-free'">{{ isPremiumPlano ? 'PRO' : 'FREE' }}</span>
            </span>
            <div class="perfil-acoes">
              <button v-if="!isPremiumPlano" @click="alert('Integração de pagamento em breve!')" class="btn-upgrade">⭐ Fazer Upgrade</button>
              <button @click="fazerLogout">Sair</button>
            </div>
          </div>
        </div>
      </div>

      <nav class="menu">
        <button @click="telaAtual = 'dashboard'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'dashboard' }">Dashboard</button>
        <button @click="telaAtual = 'cartoes'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'cartoes' }">Cartões e Contas</button>
        <button @click="telaAtual = 'fixas'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'fixas' }">Despesas Fixas</button>
        <button @click="telaAtual = 'metas'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'metas' }">Metas e Objetivos</button>
        
        <div class="menu-grupo">
          <button @click="menuLancamentosAberto = !menuLancamentosAberto" class="btn-grupo">Lançamentos <span class="seta-menu">▼</span></button>
          <div v-show="menuLancamentosAberto" class="submenu">
            <button @click="telaAtual = 'lancamentos'" :class="{ ativo: telaAtual === 'lancamentos' }">Registros</button>
            <button @click="telaAtual = 'categorias'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'categorias' }">Categorias</button>
          </div>
        </div>
        
        <button @click="telaAtual = 'projecao'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'projecao' }">Fluxo de Caixa (Futuro)</button>
        <button @click="telaAtual = 'dre'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'dre' }">DRE (Visão Anual)</button>

        <button @click="telaAtual = 'familia'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'familia' }" style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 15px;">Família</button>
        <button @click="telaAtual = 'auditoria'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'auditoria' }">Auditoria</button>
      </nav>
    </aside>

    <main class="conteudo-principal">
      <header class="barra-topo flex-header">
        <h1>
          {{ telaAtual === 'dashboard' ? 'Dashboard Financeiro' : 
             telaAtual === 'cartoes' ? 'Cartões e Contas Bancárias' : 
             telaAtual === 'fixas' ? 'Despesas Fixas Mensais' :
             telaAtual === 'metas' ? 'Metas e Objetivos' :
             telaAtual === 'lancamentos' ? 'Gestão de Lançamentos' : 
             telaAtual === 'projecao' ? 'Projeção de Fluxo de Caixa' : 
             telaAtual === 'dre' ? 'DRE (Demonstrativo de Resultados)' : 
             telaAtual === 'categorias' ? 'Categorias' : 
             telaAtual === 'auditoria' ? 'Auditoria da Família' : 'Família' }}
        </h1>
        
        <div class="navegador-mes" v-if="['dashboard', 'lancamentos', 'fixas', 'cartoes'].includes(telaAtual)">
          <button @click="alterarMes(-1)" class="btn-seta">&lt;</button>
          <span class="mes-display">{{ mesFormatado }}</span>
          <button @click="alterarMes(1)" class="btn-seta">&gt;</button>
        </div>
        <div class="navegador-mes" v-if="telaAtual === 'dre' && isPremiumPlano">
          <button @click="alterarAnoDRE(-1)" class="btn-seta">&lt;</button>
          <span class="mes-display">{{ anoDRE }}</span>
          <button @click="alterarAnoDRE(1)" class="btn-seta">&gt;</button>
        </div>
      </header>

      <section v-if="telaAtual === 'dre'" class="tela-dre animacao-entrada">
        
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3rem; margin-bottom: 10px;">📊</div>
          <h2>Visão Anual e Sazonalidade</h2>
          <p class="text-muted mb-20">O módulo DRE Matricial permite visualizar seu ano inteiro de ponta a ponta, entendendo a sazonalidade e extraindo médias automáticas de todos os seus gastos. É uma funcionalidade exclusiva para assinantes PRO.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <div v-else class="cartao">
          <div class="flex-header mb-20" style="margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid var(--borda);">
            <div><h2 class="titulo-clean mb-0">Visão Anual Matricial (Competência)</h2><p class="text-sm text-muted">Entenda sua sazonalidade de gastos mês a mês.</p></div>
          </div>
          
          <div class="tabela-responsiva">
            <table class="tabela tabela-dre">
              <thead>
                <tr>
                  <th class="col-fixa bg-table-header">Categoria</th>
                  <th v-for="m in mesesCurtos" :key="m" class="centro bg-table-header">{{ m }}</th>
                  <th class="centro col-destaque bg-table-header" style="border-left: 2px solid var(--borda);">TOTAL</th>
                  <th class="centro bg-table-header">MÉDIA</th>
                </tr>
              </thead>
              <tbody>
                <tr class="linha-receita">
                  <td class="col-fixa bg-table-header"><strong>Receitas (+)</strong></td>
                  <td v-for="(v, i) in matrizDRE.receitas" :key="i" class="centro" :class="{'texto-verde': v > 0, 'text-muted text-xs': v === 0}">{{ v ? formatarMoeda(v) : '-' }}</td>
                  <td class="centro col-destaque font-weight-bold texto-verde" style="border-left: 2px solid var(--borda);">{{ formatarMoeda(matrizDRE.totaisAno.receitas) }}</td>
                  <td class="centro">{{ formatarMoeda(matrizDRE.totaisAno.receitas / 12) }}</td>
                </tr>
                <tr style="background-color: var(--input-bg);">
                  <td class="col-fixa texto-vermelho"><strong>Despesas (-)</strong></td>
                  <td colspan="14"></td>
                </tr>
                <tr v-for="cat in matrizDRE.listaCategorias" :key="cat.nome" class="linha-hover">
                  <td class="col-fixa text-muted" style="background: var(--bg-cartao);">{{ cat.nome }}</td>
                  <td v-for="(v, i) in cat.valores" :key="i" class="centro text-sm" :class="{'text-muted text-xs': v === 0}">{{ v ? formatarMoeda(v) : '-' }}</td>
                  <td class="centro col-destaque font-weight-bold" style="border-left: 2px solid var(--borda);">{{ formatarMoeda(cat.total) }}</td>
                  <td class="centro text-sm">{{ formatarMoeda(cat.media) }}</td>
                </tr>
                <tr class="linha-meta mt-10" style="border-top: 2px solid var(--borda);">
                  <td class="col-fixa texto-azul"><strong>Aportes / Metas (🎯)</strong></td>
                  <td v-for="(v, i) in matrizDRE.metas" :key="i" class="centro" :class="{'texto-azul': v > 0, 'text-muted text-xs': v === 0}">{{ v ? formatarMoeda(v) : '-' }}</td>
                  <td class="centro col-destaque font-weight-bold texto-azul" style="border-left: 2px solid var(--borda);">{{ formatarMoeda(matrizDRE.totaisAno.metas) }}</td>
                  <td class="centro text-sm">{{ formatarMoeda(matrizDRE.totaisAno.metas / 12) }}</td>
                </tr>
                <tr class="linha-saldo">
                  <td class="col-fixa text-primary" style="background: var(--bg-cartao);"><strong>RESULTADO DO MÊS (=)</strong></td>
                  <td v-for="(v, i) in matrizDRE.saldo" :key="i" class="centro font-weight-bold" :class="v >= 0 ? 'texto-verde' : 'texto-vermelho'" style="background: rgba(0,0,0,0.02);">{{ formatarMoeda(v) }}</td>
                  <td class="centro col-destaque font-weight-bold" :class="matrizDRE.totaisAno.saldo >= 0 ? 'texto-verde' : 'texto-vermelho'" style="background: rgba(0,0,0,0.05); border-left: 2px solid var(--borda);">{{ formatarMoeda(matrizDRE.totaisAno.saldo) }}</td>
                  <td class="centro font-weight-bold" style="background: rgba(0,0,0,0.02);">{{ formatarMoeda(matrizDRE.totaisAno.saldo / 12) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'projecao'" class="tela-projecao animacao-entrada">
        
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3rem; margin-bottom: 10px;">🔮</div>
          <h2>Projeção de Fluxo de Caixa</h2>
          <p class="text-muted mb-20">Pare de olhar apenas para o passado. O módulo de Projeção calcula suas receitas médias, abate faturas futuras e despesas fixas para prever o seu saldo dos próximos 6 meses. Exclusivo para assinantes PRO.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <template v-else>
          <div class="cartao bento-item grafico-container" style="height: 320px; margin-bottom: 25px;">
            <h3 class="titulo-widget mb-0" style="border:none;">Seu Futuro Financeiro (6 Meses)</h3>
            <p class="text-sm text-muted mb-20">Saldo de hoje + Receita média - Despesas fixas e cartões.</p>
            <div style="height: 220px;"><Line :data="chartDataProjecao" :options="chartOptionsProjecao" /></div>
          </div>
          <div class="cartao">
            <h3 class="titulo-clean mb-20">Detalhamento Mês a Mês</h3>
            <div class="tabela-responsiva">
              <table class="tabela">
                <thead><tr><th>Mês</th><th>Receitas Previstas</th><th>Dívidas Fixas</th><th>Cartão/Parcelas</th><th>Saldo Projetado</th></tr></thead>
                <tbody>
                  <tr v-for="p in dadosProjecao" :key="p.mes">
                    <td><strong>{{ p.mes }}</strong></td>
                    <td class="texto-verde">+ {{ formatarMoeda(p.receitaMedia) }}</td>
                    <td class="text-muted">- {{ formatarMoeda(p.fixas) }}</td>
                    <td class="texto-vermelho">- {{ formatarMoeda(p.parcelas) }}</td>
                    <td>
                      <span class="etiqueta-admin" :style="{ backgroundColor: p.saldoPrevisto >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: p.saldoPrevisto >= 0 ? '#059669' : '#dc2626', border: 'none', fontSize: '0.85rem' }">
                        {{ formatarMoeda(p.saldoPrevisto) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </section>

      <section v-if="telaAtual === 'auditoria'" class="tela-auditoria animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3rem; margin-bottom: 10px;">🕵️‍♂️</div>
          <h2>Auditoria da Família</h2>
          <p class="text-muted mb-20">Para quem gerencia o dinheiro em casal ou em família, a confiança é tudo. A Auditoria grava um registro inalterável de quem apagou, editou ou criou cada lançamento. Exclusivo para assinantes PRO.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <div v-else class="cartao">
          <div class="flex-header mb-20" style="margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid var(--borda);">
            <div><h2 class="titulo-clean mb-0">Histórico de Atividades</h2><p class="text-sm text-muted">Acompanhe quem fez o quê. Os registros são imutáveis.</p></div>
            <span class="etiqueta-limite">Últimos 100 registros</span>
          </div>
          <div v-if="historicoAuditoria.length === 0" class="vazio-widget text-muted">Nenhuma atividade registrada ainda.</div>
          <div v-else class="timeline">
            <div v-for="log in historicoAuditoria" :key="log.id" class="timeline-item">
              <div class="timeline-time text-xs text-muted">{{ formatarDataHora(log.dataHora) }}</div>
              <div class="timeline-content">
                <div style="display:flex; align-items: baseline; gap: 8px; margin-bottom: 4px;"><strong class="text-primary">{{ log.usuarioNome }}</strong><span class="text-sm font-weight-bold">{{ log.acao }}</span></div>
                <div class="text-sm" style="color: var(--text-principal);">{{ log.detalhes }}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'cartoes'" class="tela-cartoes animacao-entrada">
        <input type="file" ref="inputComprovanteOculto" style="display: none" @change="processarAnexoPosterior" accept="image/*,application/pdf" />

        <div class="cartao form-elegante mb-20">
          <h2 class="titulo-clean">Nova Conta Bancária ou Cartão</h2>
          <form @submit.prevent="adicionarConta" class="formulario">
            <div class="linha-campos">
              <div class="campo flex-grow"><input v-model="novaContaNome" type="text" placeholder="Nome da instituição..." required /></div>
              <div class="campo">
                <select v-model="novaContaTipo" required>
                  <option value="Cartão de Crédito" :disabled="!isPremiumPlano">Cartão de Crédito {{ !isPremiumPlano ? '🔒 PRO' : '' }}</option>
                  <option>Conta Bancária</option>
                  <option>Dinheiro Espécie</option>
                  <option>Vale</option>
                </select>
              </div>
            </div>
            <div v-if="novaContaTipo === 'Cartão de Crédito'" class="linha-campos mt-10 animacao-entrada" style="background:var(--input-bg); padding:15px; border-radius:8px; border:1px solid var(--borda);">
              <div class="campo"><label>Limite Total (R$)</label><input v-model="novoCartaoLimite" type="number" step="0.01" placeholder="Ex: 5000" required /></div>
              <div class="campo"><label>Dia do Fechamento</label><input v-model="novoCartaoFechamento" type="number" min="1" max="31" placeholder="Ex: 20" required /></div>
              <div class="campo"><label>Dia do Vencimento</label><input v-model="novoCartaoVencimento" type="number" min="1" max="31" placeholder="Ex: 27" required /></div>
            </div>
            <button type="submit" class="btn-salvar-secundario mt-10">Criar</button>
          </form>
        </div>

        <h3 class="titulo-clean mt-30 mb-15">Cartões de Crédito</h3>
        
        <div v-if="!isPremiumPlano" class="cartao text-center mb-20" style="padding: 40px;">
          <h3 class="text-muted">🔒 Recurso Bloqueado</h3>
          <p class="text-sm text-muted">A gestão inteligente de faturas de Cartão de Crédito, com rolagem automática de parcelas e recomposição de limites, é uma função exclusiva do plano PRO.</p>
        </div>

        <div v-else>
          <div v-if="cartoesCadastrados.length === 0" class="cartao vazio-widget mb-20">Nenhum cartão de crédito cadastrado.</div>
          <div v-else class="grid-metas mb-20">
            <div v-for="cartao in cartoesCadastrados" :key="cartao.id" class="cartao cartao-credito-widget">
              <div class="cartao-header">
                <h3 class="mb-0">{{ cartao.nome }}</h3>
                <div class="acoes-cartao">
                  <button @click="editarConta(cartao)" class="btn-link" title="Editar">✏️</button>
                  <button @click="removerConta(cartao.id)" class="btn-link text-danger" title="Excluir">✖</button>
                </div>
              </div>
              
              <div class="cartao-corpo mt-20">
                <div class="limite-info mb-10 text-sm">
                  <span class="text-muted">Limite Disponível</span>
                  <strong :class="getCartaoStatusGlobal(cartao).limiteDisponivel > 0 ? 'text-primary' : 'texto-vermelho'">{{ formatarMoeda(getCartaoStatusGlobal(cartao).limiteDisponivel) }}</strong>
                </div>
                
                <span class="text-sm text-muted">Fatura do Mês ({{ mesFormatado }})</span>
                <p class="valor-fatura mb-10">{{ formatarMoeda(getFaturaDetalhada(cartao, mesFiltro).total) }}</p>
                
                <div class="barra-progresso-fundo mb-10">
                  <div class="barra-progresso-preenchida" 
                       :style="{ width: Math.min((getFaturaDetalhada(cartao, mesFiltro).total / (cartao.limite || 1)) * 100, 100) + '%', backgroundColor: getFaturaDetalhada(cartao, mesFiltro).pago ? '#10b981' : '#f97316' }">
                  </div>
                </div>
                <div class="limite-info text-sm text-muted">
                  <span>Limite Total: {{ formatarMoeda(cartao.limite) }}</span>
                  <span>Vence dia {{ String(cartao.diaVencimento).padStart(2, '0') }}</span>
                </div>
              </div>

              <div class="cartao-footer mt-20">
                <span v-if="getFaturaDetalhada(cartao, mesFiltro).pago" class="etiqueta-admin" style="background:#10b981; color:white; border:none; padding:8px 12px; width: 100%; text-align: center;">Fatura Paga ✓</span>
                
                <template v-else-if="getFaturaDetalhada(cartao, mesFiltro).total > 0">
                  <button v-if="getFaturaDetalhada(cartao, mesFiltro).isFechada" @click="iniciarPagamentoFatura(cartao, getFaturaDetalhada(cartao, mesFiltro).total)" class="btn-salvar-secundario" style="width: 100%;">Pagar Fatura</button>
                  <span v-else class="text-muted text-sm font-weight-bold" style="width: 100%; text-align: center; display: block; padding: 8px; border: 1px dashed var(--input-border); border-radius: 6px;">Fatura Aberta (Fecha dia {{ String(cartao.diaFechamento).padStart(2, '0') }})</span>
                </template>
                
                <span v-else class="text-muted text-sm font-weight-bold" style="width: 100%; text-align: center; display: block;">Fatura Zerada</span>
              </div>
              
              <details class="detalhes-fatura mt-20">
                <summary class="text-primary font-weight-bold" style="cursor:pointer; font-size:0.85rem;">Ver compras da fatura</summary>
                <div class="lista-compras mt-10">
                  <div v-if="getFaturaDetalhada(cartao, mesFiltro).transacoes.length === 0" class="text-muted text-sm">Nenhuma compra neste ciclo.</div>
                  <div v-for="t in getFaturaDetalhada(cartao, mesFiltro).transacoes" :key="t.id" class="compra-item-bloco mt-10" style="padding-bottom:10px; border-bottom:1px solid var(--borda);">
                    <div style="display:flex; justify-content: space-between; width: 100%;">
                      <span>{{ formatarData(t.dataCompra || t.data) }} - {{ t.descricao }}</span>
                      <strong>{{ formatarMoeda(t.valor) }}</strong>
                    </div>
                    <div class="acoes-tabela mt-5" style="justify-content: flex-end; width: 100%;">
                      <button @click="apagarTransacao(t)" class="btn-link-apagar">Apagar</button>
                      <button v-if="!t.comprovanteUrl" @click="abrirSeletorArquivo(t)" class="btn-link-anexo" :disabled="uploadingId === t.id">{{ uploadingId === t.id ? '⏳' : '📎 Anexar' }}</button>
                      <a v-if="t.comprovanteUrl" :href="t.comprovanteUrl" target="_blank" class="link-comprovante">[Ver Anexo]</a>
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>

        <h3 class="titulo-clean mt-30 mb-15">Contas Bancárias, Débito e Outros</h3>
        <div class="cartao">
          <div class="tabela-responsiva">
            <table class="tabela">
              <thead><tr><th>Instituição</th><th>Tipo</th><th>Ações</th></tr></thead>
              <tbody>
                <tr v-if="outrasContasCadastradas.length === 0"><td colspan="3" class="centro text-muted">Nenhuma conta cadastrada.</td></tr>
                <tr v-for="conta in outrasContasCadastradas" :key="conta.id">
                  <td><strong>{{ conta.nome }}</strong></td>
                  <td><span class="etiqueta-limpa">{{ conta.tipo }}</span></td>
                  <td>
                    <button @click="editarConta(conta)" class="btn-link" style="margin-right:15px;">Editar</button>
                    <button @click="removerConta(conta.id)" class="btn-link text-danger">Excluir</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="modalPagarFatura && isPremiumPlano" class="modal-overlay">
          <div class="cartao form-elegante modal-conteudo animacao-entrada">
            <h2 class="titulo-clean">Pagar Fatura: {{ cartaoAlvoPagamento?.nome }}</h2>
            <p class="text-muted mb-20">Isso registrará a saída de dinheiro da sua conta bancária e restabelecerá o limite do cartão.</p>
            <form @submit.prevent="confirmarPagamentoFatura" class="formulario">
              <div class="campo"><label>Valor da Fatura (R$)</label><input v-model="valorFaturaPagamento" type="number" step="0.01" disabled /></div>
              <div class="campo mt-10">
                <label>De qual conta o dinheiro saiu?</label>
                <select v-model="contaOrigemPagamentoFatura" required>
                  <option v-for="c in outrasContasCadastradas" :key="c.id" :value="c.nome">{{ c.nome }}</option>
                </select>
              </div>
              <div class="flex-header mt-20 mb-0">
                <button type="button" @click="modalPagarFatura = false" class="btn-link text-danger">Cancelar</button>
                <button type="submit" class="btn-salvar-secundario">Confirmar Pagamento</button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'fixas'" class="tela-fixas animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3rem; margin-bottom: 10px;">📅</div>
          <h2>Despesas Fixas Automáticas</h2>
          <p class="text-muted mb-20">Esquecer de pagar uma conta de consumo gera multas. O módulo de Despesas Fixas avisa você 3 dias antes do vencimento e lança o gasto com um único clique. Exclusivo para assinantes PRO.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <template v-else>
          <div class="cartao form-elegante">
            <h2 class="titulo-clean">Cadastrar Despesa Recorrente</h2>
            <form @submit.prevent="adicionarDividaFixa" class="formulario">
              <div class="linha-campos">
                <div class="campo campo-largo"><input v-model="novaDividaNome" type="text" placeholder="Nome (Ex: Internet, Condomínio...)" required /></div>
                <div class="campo"><input v-model="novaDividaValor" type="number" step="0.01" placeholder="Valor Base (R$)" required /></div>
                <div class="campo campo-pequeno"><input v-model="novaDividaDia" type="number" min="1" max="31" placeholder="Dia do Vencimento" required title="Dia Vencimento" /></div>
              </div>
              <div class="linha-campos mt-10">
                <div class="campo"><label>Categoria</label><select v-model="dividaCategoria" required><option v-for="cat in categoriasDisponiveis" :key="cat.id" :value="cat.nome">{{ cat.nome }}</option></select></div>
                <div class="campo"><label>Subcategoria</label><select v-model="dividaSubcategoria" :disabled="subcategoriasDividaDropdown.length === 0"><option v-if="subcategoriasDividaDropdown.length === 0" value="">-- Nenhuma --</option><option v-for="sub in subcategoriasDividaDropdown" :key="sub" :value="sub">{{ sub }}</option></select></div>
              </div>
              <button type="submit" class="btn-salvar-secundario mt-10">Cadastrar Conta Fixa</button>
            </form>
          </div>

          <div class="cartao mt-20">
            <h3 class="titulo-clean mb-20">Contas do Mês ({{ mesFormatado }})</h3>
            <div class="tabela-responsiva">
              <table class="tabela">
                <thead><tr><th>Dia</th><th>Descrição</th><th>Valor Base</th><th>Status</th><th>Ações</th></tr></thead>
                <tbody>
                  <tr v-if="dividasFixas.length === 0"><td colspan="5" class="centro text-muted">Nenhuma despesa fixa cadastrada.</td></tr>
                  <tr v-for="divida in dividasFixas" :key="divida.id">
                    <td><strong>{{ String(divida.diaVencimento).padStart(2, '0') }}</strong></td>
                    <td><div class="descricao-celula"><span class="desc-texto">{{ divida.nome }}</span><span class="etiqueta-limpa">{{ divida.categoria }}</span></div></td>
                    <td>{{ formatarMoeda(divida.valor) }} <button @click="editarValorDivida(divida)" class="btn-link" title="Editar Valor Base">✏️</button></td>
                    <td>
                      <span v-if="divida.pagamentos?.includes(mesFiltro)" class="etiqueta-admin" style="background:#10b981; color:white; border:none;">Pago neste mês</span>
                      <span v-else class="etiqueta-limpa">Aguardando Pagamento</span>
                    </td>
                    <td>
                      <div class="acoes-tabela">
                        <button v-if="!divida.pagamentos?.includes(mesFiltro)" @click="iniciarPagamentoFixo(divida)" class="btn-salvar-secundario" style="padding: 6px 12px; font-size: 0.75rem;">PAGO!</button>
                        <button @click="removerDividaFixa(divida.id)" class="btn-link-apagar">Apagar Título</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </section>

      <section v-if="telaAtual === 'metas'" class="tela-metas animacao-entrada">
        <div class="cartao form-elegante">
          <h2 class="titulo-clean">Nova Meta Financeira</h2>
          <form @submit.prevent="adicionarMeta" class="formulario em-linha">
            <div class="campo flex-grow"><input v-model="novaMetaNome" type="text" placeholder="Nome do objetivo..." required /></div>
            <div class="campo"><input v-model="novaMetaObjetivo" type="number" step="0.01" placeholder="Objetivo (R$)" required /></div>
            <button type="submit" class="btn-salvar-secundario">Criar</button>
          </form>
        </div>
        <div class="grid-metas mt-20">
          <div class="cartao meta-card" :class="{'atingida': meta.valorAtual >= meta.valorObjetivo}" v-for="meta in metas" :key="meta.id">
            <div class="meta-cabecalho"><h3 class="titulo-widget mb-0">{{ meta.nome }}</h3><button @click="removerMeta(meta.id)" class="btn-fechar">✖</button></div>
            <p class="meta-valores">{{ formatarMoeda(meta.valorAtual) }} <span class="text-muted">de {{ formatarMoeda(meta.valorObjetivo) }}</span></p>
            <div class="barra-progresso-fundo mb-20"><div class="barra-progresso-preenchida" :style="{ width: Math.min((meta.valorAtual / meta.valorObjetivo) * 100, 100) + '%' }"></div></div>
            <div class="meta-acoes">
              <span class="meta-percentual" v-if="meta.valorAtual < meta.valorObjetivo">{{ Math.round((meta.valorAtual / meta.valorObjetivo) * 100) }}% concluído</span>
              <span class="meta-percentual-atingida" v-else>🎉 Meta Atingida!</span>
              <button v-if="meta.valorAtual < meta.valorObjetivo" @click="iniciarAporte(meta)" class="btn-salvar-secundario btn-sm">Guardar Dinheiro</button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'familia'" class="tela-familia animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3rem; margin-bottom: 10px;">👨‍👩‍👧‍👦</div>
          <h2>Contas Compartilhadas</h2>
          <p class="text-muted mb-20">Gestão financeira em casal é o segredo da riqueza. Convide outras pessoas para acessar, visualizar e lançar despesas no mesmo ambiente que você. Exclusivo para assinantes PRO.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <template v-else>
          <div class="cartao form-elegante">
            <h2 class="titulo-clean">Membros da Família</h2>
            <div class="tabela-responsiva mb-20 mt-20">
              <table class="tabela">
                <thead><tr><th>E-mail</th><th>Ações</th></tr></thead>
                <tbody>
                  <tr v-for="email in familiaAtual.membros" :key="email">
                    <td><strong>{{ email }}</strong><span v-if="familiaAtual.admin === email" class="etiqueta-admin ml-10">👑 Admin</span></td>
                    <td><button v-if="isAdmin && email !== usuarioLogado.email" @click="removerMembro(email)" class="btn-link text-danger">Revogar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="isAdmin">
              <h3 class="titulo-clean mt-30">Convidar Pessoa</h3>
              <form @submit.prevent="convidarMembro" class="formulario em-linha">
                <div class="campo flex-grow"><input v-model="emailConvite" type="email" placeholder="E-mail..." required /></div>
                <button type="submit" class="btn-salvar-secundario" :disabled="statusEnvio !== ''">{{ statusEnvio || 'Enviar Convite' }}</button>
              </form>
            </div>
          </div>
        </template>
      </section>

      <section v-if="telaAtual === 'dashboard'" class="tela-dashboard animacao-entrada">
        
        <div v-if="contasVencendo.length > 0" class="alerta-vencimento mb-20 animacao-entrada">
          <div class="alerta-header">⚠️ Atenção: Despesas Fixas exigem sua ação!</div>
          <div v-for="conta in contasVencendo" :key="conta.id" class="alerta-linha">
            <span><strong>{{ conta.nome }}</strong> ({{ formatarMoeda(conta.valor) }})</span>
            <div style="display:flex; align-items:center; gap: 15px;">
              <span :class="conta.corClass"><strong>{{ conta.status }}</strong></span>
              <button @click="iniciarPagamentoFixo(conta)" class="btn-export">Pagar Agora</button>
            </div>
          </div>
        </div>

        <div class="grid-resumo mb-20">
          <div class="cartao-resumo receitas"><h3>Receitas</h3><p>{{ formatarMoeda(totalReceitas) }}</p></div>
          <div class="cartao-resumo despesas"><h3>Despesas / Metas</h3><p>{{ formatarMoeda(totalDespesas + totalAportes) }}</p></div>
          <div class="cartao-resumo saldo" :class="saldoAtualMes >= 0 ? 'saldo-positivo' : 'saldo-negativo'"><h3>Saldo Livre</h3><p>{{ formatarMoeda(saldoAtualMes) }}</p></div>
        </div>

        <div class="dashboard-bento">
          <div class="cartao bento-item widget-orcamento">
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
            <div v-else class="vazio-widget">Nenhum limite de categoria definido.</div>
          </div>
          
          <div class="cartao bento-item widget-cartoes">
            <h3 class="titulo-widget">Últimas Compras (Cartão)</h3>
            <div v-if="ultimasComprasCartao.length > 0 && isPremiumPlano" class="lista-compras-dash">
              <div v-for="t in ultimasComprasCartao" :key="t.id" class="compra-item-dash mb-15 pb-10" style="border-bottom: 1px solid var(--input-bg); display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column;">
                  <span class="font-weight-bold" style="font-size: 0.9rem;">{{ t.descricao }}</span>
                  <span class="text-xs text-muted">{{ formatarData(t.dataCompra || t.data) }} no {{ t.conta }}</span>
                </div>
                <strong class="texto-vermelho">{{ formatarMoeda(t.valor) }}</strong>
              </div>
            </div>
            <div v-else-if="!isPremiumPlano" class="vazio-widget text-muted">Gestão de Cartões requer plano PRO.</div>
            <div v-else class="vazio-widget text-muted">Nenhuma compra no cartão registrada.</div>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'lancamentos'" class="tela-lancamentos animacao-entrada">
        
        <input type="file" ref="inputComprovanteOculto" style="display: none" @change="processarAnexoPosterior" accept="image/*,application/pdf" />

        <button v-if="!mostrarFormulario" @click="alternarFormulario" class="fab-btn animacao-entrada" title="Novo Lançamento">+</button>

        <div v-if="mostrarFormulario" class="cartao form-elegante animacao-entrada mb-20">
          <div class="cabecalho-form">
            <h2 class="titulo-clean mb-0">{{ dividaSendoPaga ? 'Confirmar Pagamento de Despesa Fixa' : 'Novo Lançamento' }}</h2>
            <button @click="alternarFormulario(); dividaSendoPaga = null;" class="btn-fechar-form">✖</button>
          </div>
          
          <div v-if="categoriasDisponiveis.length === 0 || contasDisponiveis.length === 0" class="alerta-categorias">Cadastre 1 Categoria e 1 Conta para lançar.</div>
          
          <form v-else @submit.prevent="adicionarTransacao" class="formulario">
            <div class="toggle-container quadruplo" v-if="!dividaSendoPaga">
              <button type="button" :class="['btn-toggle', tipo === 'despesa' ? 'ativo-despesa' : '']" @click="tipo = 'despesa'">Despesa</button>
              <button type="button" :class="['btn-toggle', tipo === 'receita' ? 'ativo-receita' : '']" @click="tipo = 'receita'">Receita</button>
              <button type="button" :class="['btn-toggle', tipo === 'transferencia' ? 'ativo-transferencia' : '']" @click="tipo = 'transferencia'">Transferência</button>
              <button type="button" :class="['btn-toggle', tipo === 'meta' ? 'ativo-meta' : '']" @click="tipo = 'meta'" :disabled="metasPendentes.length === 0">Meta</button>
            </div>
            
            <div class="linha-campos mt-20">
              <div class="campo"><label>Data da Transação</label><input v-model="dataLancamento" type="date" required /></div>
              <div class="campo campo-largo"><label>Descrição</label><input v-model="descricao" type="text" required /></div>
              <div class="campo"><label>Valor (R$)</label><input v-model="valor" type="number" step="0.01" required /></div>
            </div>
            
            <div class="linha-campos">
              <div class="campo">
                <label>{{ tipo === 'receita' ? 'Conta de Entrada' : 'Conta de Saída' }}</label>
                <select v-model="contaSelecionada" required>
                  <option v-for="conta in contasDisponiveis" :key="conta.id" :value="conta.nome" :disabled="conta.tipo === 'Cartão de Crédito' && !isPremiumPlano">{{ conta.nome }} {{ conta.tipo === 'Cartão de Crédito' && !isPremiumPlano ? '🔒 PRO' : '' }}</option>
                </select>
              </div>

              <div v-if="tipo === 'transferencia'" class="campo">
                <label>Conta de Destino</label>
                <select v-model="contaDestinoSelecionada" required>
                  <option v-for="conta in contasDisponiveis" :key="conta.id" :value="conta.nome" :disabled="conta.tipo === 'Cartão de Crédito' && !isPremiumPlano">{{ conta.nome }} {{ conta.tipo === 'Cartão de Crédito' && !isPremiumPlano ? '🔒 PRO' : '' }}</option>
                </select>
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
            
            <div class="secao-parcelamento" v-if="tipo !== 'meta' && !dividaSendoPaga">
              <label class="checkbox-sutil"><input type="checkbox" v-model="isParcelado"><span class="texto-check">Lançamento Parcelado / Recorrente</span></label>
              
              <div v-if="isParcelado" class="opcoes-parcelamento animacao-entrada">
                <div class="campo campo-pequeno"><label>Parcelas</label><input v-model="numeroParcelas" type="number" min="2" max="120" /></div>
                <div class="campo" v-if="!isContaCartaoSelecionada"><label>Vencimento 1ª Parcela</label><input v-model="dataPrimeiraParcela" type="date" required /></div>
                <div class="campo" v-else style="justify-content: center;"><span class="text-sm font-weight-bold" style="color:#10b981;">✓ Parcelas vinculadas nas faturas seguintes</span></div>
              </div>
            </div>

            <div class="linha-campos mb-20 mt-20" style="border-top: 1px dashed var(--borda); padding-top: 20px;">
              <div class="campo" v-if="isPremiumPlano">
                <label>Comprovante / Nota Fiscal</label>
                <input type="file" id="input-comprovante" @change="selecionarArquivo" accept="image/*,application/pdf" class="input-arquivo" />
              </div>
              <div v-else class="text-sm text-muted">
                📎 O armazenamento em nuvem de recibos e notas fiscais é exclusivo do plano PRO.
              </div>
            </div>

            <button type="submit" :class="['btn-salvar-elegante', `btn-cor-${tipo}`]" :disabled="uploadProgresso">
              {{ uploadProgresso ? 'Enviando para a Nuvem...' : 'Salvar Registro' }}
            </button>
          </form>
        </div>

        <div class="cartao mt-20">
          <div class="cabecalho-lista-tabela">
            <h3 class="titulo-clean mb-0">Lançamentos de Contas ({{ mesFormatado }})</h3>
            <div class="acoes-exportacao">
              <button v-if="isPremiumPlano" @click="exportarCSV" class="btn-export">Exportar Excel</button>
              <button v-if="isPremiumPlano" @click="exportarPDF" class="btn-export pdf-btn">Exportar PDF</button>
              <span v-else class="text-muted text-xs">Exportações 🔒 PRO</span>
            </div>
          </div>

          <div class="tabela-responsiva mt-20">
            <table class="tabela">
              <thead><tr><th>Data</th><th>Descrição / Conta</th><th>Categoria</th><th>Resp.</th><th>Valor</th><th>Ações</th></tr></thead>
              <tbody>
                <tr v-if="transacoesVisiveisTabela.length === 0"><td colspan="6" class="centro text-muted">Nenhum lançamento no período.</td></tr>
                <tr v-for="t in transacoesVisiveisTabela" :key="t.id">
                  <td>{{ formatarData(t.data) }}</td>
                  <td>
                    <div class="descricao-celula">
                      <span class="desc-texto">{{ t.descricao }} <a v-if="t.comprovanteUrl && isPremiumPlano" :href="t.comprovanteUrl" target="_blank" class="link-comprovante">[Ver Anexo]</a></span>
                      <span class="etiqueta-pagamento">{{ t.tipo === 'transferencia' && t.contaDestino ? t.conta + ' ➔ ' + t.contaDestino : t.conta || '-' }}</span>
                    </div>
                  </td>
                  <td>
                    <span v-if="t.tipo === 'transferencia'" class="etiqueta-transf">Acerto</span>
                    <span v-else-if="t.tipo === 'meta'" class="etiqueta-meta">🎯 Meta: {{ t.nomeMeta }}</span>
                    <span v-else class="etiqueta-limpa">{{ t.categoria }} {{ t.subcategoria ? ' / ' + t.subcategoria : '' }}</span>
                  </td>
                  <td><span v-if="t.tipo === 'transferencia'">{{ extrairNome(t.responsavel) }} ➔ {{ extrairNome(t.beneficiario) }}</span><span v-else>{{ extrairNome(t.responsavel) }}</span></td>
                  <td :class="t.tipo === 'receita' ? 'texto-verde' : t.tipo === 'despesa' ? 'texto-vermelho' : t.tipo === 'meta' ? 'texto-azul' : 'texto-roxo'">
                    {{ t.tipo === 'receita' ? '+' : t.tipo === 'despesa' ? '-' : t.tipo === 'meta' ? '↓' : '↔' }} {{ formatarMoeda(t.valor) }}
                  </td>
                  <td>
                    <div class="acoes-tabela">
                      <button @click="apagarTransacao(t)" class="btn-link-apagar">Apagar</button>
                      <button v-if="!t.comprovanteUrl && isPremiumPlano" @click="abrirSeletorArquivo(t)" class="btn-link-anexo" :disabled="uploadingId === t.id">{{ uploadingId === t.id ? '⏳' : '📎 Anexar' }}</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'categorias'" class="tela-categorias animacao-entrada">
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
              <span class="etiqueta-limite ml-10" :class="{'tem-limite': cat.limiteMensal > 0}">{{ cat.limiteMensal > 0 ? `Teto: ${formatarMoeda(cat.limiteMensal)}` : 'Sem teto' }}</span>
            </div>
            <div class="acoes-categoria">
              <button v-if="isPremiumPlano" @click="definirLimite(cat)" class="btn-link text-primary">Definir Limite</button>
              <button v-else class="btn-link text-muted" title="Requer plano PRO" style="cursor: not-allowed;">Limites 🔒</button>
              <button @click="removerCategoria(cat.id)" class="btn-link text-danger">Excluir</button>
            </div>
          </div>
          <div class="area-subcategorias">
            <div class="etiquetas-subcategorias"><span v-for="sub in cat.subcategorias" :key="sub" class="etiqueta-sub">{{ sub }} <button @click="removerSubcategoria(cat, sub)" class="btn-fechar">X</button></span></div>
            <form @submit.prevent="adicionarSubcategoria(cat)" class="form-subcategoria"><input v-model="inputsSubcategoria[cat.id]" type="text" placeholder="Subcategoria..." class="input-pequeno"/><button type="submit" class="btn-add-mini">+</button></form>
          </div>
        </div>
      </section>

    </main>
    <button @click="alternarTema" class="fab-tema" :title="temaEscuro ? 'Modo Claro' : 'Modo Escuro'">{{ temaEscuro ? '☀️' : '🌙' }}</button>
    
    <button @click="isPremiumPlano = !isPremiumPlano" class="fab-teste-plano" :class="isPremiumPlano ? 'fab-pro' : 'fab-free'" title="Alternar entre contas Free e Premium (Apenas para teste)">
      {{ isPremiumPlano ? '👑 MODO PRO' : '🌱 MODO FREE' }}
    </button>
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

.tema-claro { --bg-app: #f8fafc; --bg-sidebar: #0f172a; --text-sidebar: #94a3b8; --bg-cartao: #ffffff; --bg-form: #ffffff; --text-principal: #1e293b; --text-muted: #64748b; --borda: #e2e8f0; --input-bg: #f8fafc; --input-border: #cbd5e1; --primary: #2563eb; --receita: #059669; --despesa: #dc2626; --transferencia: #7c3aed; --meta-cor: #0284c7;}
.tema-escuro { --bg-app: #0f172a; --bg-sidebar: #020617; --text-sidebar: #64748b; --bg-cartao: #1e293b; --bg-form: #1e293b; --text-principal: #f8fafc; --text-muted: #94a3b8; --borda: #334155; --input-bg: #0f172a; --input-border: #475569; --primary: #3b82f6; --receita: #10b981; --despesa: #ef4444; --transferencia: #8b5cf6; --meta-cor: #0ea5e9;}

.app-layout { display: flex; min-height: 100vh; background-color: var(--bg-app); color: var(--text-principal); font-family: 'Inter', sans-serif; transition: 0.3s; }

/* NOVO: Etiquetas PRO e FREE da Sidebar */
.tag-pro { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 700; letter-spacing: 0.5px; vertical-align: middle;}
.tag-free { background: #334155; color: #cbd5e1; font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 700; letter-spacing: 0.5px; vertical-align: middle;}
.btn-upgrade { background: rgba(245, 158, 11, 0.1); color: #f59e0b !important; font-weight: 600 !important; text-decoration: none !important; padding: 4px 8px !important; border-radius: 4px; margin-right: 10px;}
.btn-upgrade:hover { background: rgba(245, 158, 11, 0.2); }
.paywall-container { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; }

/* NOVO: Botão de Teste de Planos */
.fab-teste-plano { position: fixed; bottom: 40px; left: 340px; padding: 10px 20px; border-radius: 30px; font-size: 0.8rem; font-weight: 700; color: white; border: none; cursor: pointer; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: 0.2s; letter-spacing: 0.5px;}
.fab-teste-plano:hover { transform: translateY(-3px); }
.fab-pro { background-color: #f59e0b; }
.fab-free { background-color: #475569; }

.sidebar { width: 260px; background-color: var(--bg-sidebar); color: var(--text-sidebar); display: flex; flex-direction: column; flex-shrink: 0; border-right: 1px solid rgba(255,255,255,0.05);}
.logo { padding: 35px 25px 25px 25px; }
.logo h2 { margin: 0 0 25px 0; font-size: 1.3rem; color: #f8fafc; font-weight: 700; letter-spacing: -0.5px;}
.perfil-card { display: flex; align-items: center; gap: 12px; }
.avatar-google { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; }
.perfil-info { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.nome-usuario { font-weight: 500; color: #f8fafc; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.perfil-acoes button { background: none; border: none; color: var(--text-sidebar); font-size: 0.75rem; padding: 0; cursor: pointer; transition: 0.2s; text-decoration: underline; }
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
.texto-laranja { color: #f97316; }

.conteudo-principal { flex-grow: 1; padding: 45px 55px; overflow-y: auto; padding-bottom: 120px; } 
.flex-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 35px; }
.barra-topo h1 { margin: 0; font-size: 1.4rem; font-weight: 700; color: var(--text-principal); letter-spacing: -0.5px;}

/* DRE CSS */
.tabela-dre { min-width: 1000px; border-collapse: separate; border-spacing: 0; }
.tabela-dre th, .tabela-dre td { padding: 12px 10px; border-bottom: 1px solid var(--input-bg); font-size: 0.85rem; white-space: nowrap; }
.tabela-dre .col-fixa { position: sticky; left: 0; background: var(--bg-cartao); z-index: 10; font-weight: 500; border-right: 2px solid var(--input-bg); width: 220px; }
.tabela-dre .bg-table-header { background-color: var(--input-bg) !important; }
.tabela-dre .col-destaque { background-color: rgba(0,0,0,0.02); }
.linha-hover:hover td { background-color: rgba(0,0,0,0.01) !important; }
.linha-receita td { background-color: rgba(16, 185, 129, 0.03) !important; }
.linha-saldo td { padding: 16px 10px !important; border-top: 2px solid var(--borda); }

/* AUDITORIA CSS */
.tela-auditoria .timeline { display: flex; flex-direction: column; position: relative; padding-left: 20px; border-left: 2px solid var(--input-border); }
.timeline-item { position: relative; margin-bottom: 25px; padding-left: 25px; }
.timeline-item::before { content: ''; position: absolute; left: -26px; top: 0; width: 10px; height: 10px; background-color: var(--primary); border-radius: 50%; border: 3px solid var(--bg-cartao); }
.timeline-time { margin-bottom: 4px; font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; }
.timeline-content { background-color: var(--input-bg); padding: 12px 15px; border-radius: 6px; border: 1px solid var(--borda); }

/* ALERTA DASHBOARD */
.alerta-vencimento { background-color: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; overflow: hidden; }
.alerta-header { background-color: rgba(239, 68, 68, 0.1); color: var(--despesa); padding: 12px 15px; font-weight: 700; font-size: 0.9rem; border-bottom: 1px solid rgba(239, 68, 68, 0.2); }
.alerta-linha { display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid rgba(239, 68, 68, 0.1); color: var(--text-principal); }
.alerta-linha:last-child { border-bottom: none; }

/* CARTÕES DE CRÉDITO WIDGET */
.cartao-credito-widget { background: linear-gradient(135deg, var(--bg-cartao) 0%, var(--bg-form) 100%); border: 1px solid var(--borda); }
.cartao-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--borda); padding-bottom: 15px; }
.valor-fatura { font-size: 2.2rem; font-weight: 700; color: var(--text-principal); letter-spacing: -1px; }
.limite-info { display: flex; justify-content: space-between; margin-top: 5px; }
.cartao-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 15px; border-top: 1px dashed var(--borda); }
.detalhes-fatura summary { outline: none; user-select: none; }
.lista-compras { max-height: 300px; overflow-y: auto; padding-right: 10px; }
.compra-item-bloco { display: flex; flex-wrap: wrap; font-size: 0.8rem; color: var(--text-principal); }
.acoes-cartao { display: flex; gap: 10px; }

/* MODAL PAGAMENTO FATURA */
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; backdrop-filter: blur(4px); }
.modal-conteudo { width: 100%; max-width: 400px; }

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

.etiqueta-admin { background-color: rgba(245, 158, 11, 0.1); color: #d97706; font-size: 0.7rem; font-weight: 600; padding: 3px 6px; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.3); }

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
.mt-5 { margin-top: 5px; }
.mt-10 { margin-top: 10px; }
.mt-20 { margin-top: 20px; }
.mt-30 { margin-top: 30px; }
.mb-0 { margin-bottom: 0; }
.mb-10 { margin-bottom: 10px; }
.mb-15 { margin-bottom: 15px; }
.pb-10 { padding-bottom: 10px; }
.mb-20 { margin-bottom: 20px; }
.titulo-clean { font-size: 1rem; font-weight: 600; margin: 0 0 15px 0; color: var(--text-principal); }
.text-muted { color: var(--text-muted); }

.fab-btn { position: fixed; bottom: 40px; right: 40px; width: 56px; height: 56px; border-radius: 50%; background-color: var(--primary); color: white; font-size: 1.8rem; font-weight: 300; border: none; box-shadow: 0 8px 24px rgba(37, 99, 235, 0.3); cursor: pointer; display: flex; justify-content: center; align-items: center; transition: 0.2s; z-index: 100; }
.fab-btn:hover { transform: translateY(-3px); box-shadow: 0 12px 28px rgba(37, 99, 235, 0.4); }
.fab-tema { position: fixed; bottom: 40px; left: 280px; width: 40px; height: 40px; border-radius: 50%; background-color: var(--bg-cartao); border: 1px solid var(--borda); box-shadow: 0 4px 12px rgba(0,0,0,0.05); cursor: pointer; font-size: 1rem; display: flex; justify-content: center; align-items: center; transition: 0.2s; z-index: 100; }
.fab-tema:hover { transform: scale(1.05); }

/* EXPORTAÇÃO E BOTOES */
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

/* AÇÕES DA TABELA */
.acoes-tabela { display: flex; align-items: center; gap: 12px; }
.btn-link-apagar { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.8rem; text-decoration: underline; }
.btn-link-apagar:hover { color: var(--despesa); }
.btn-link-anexo { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: 0.2s; display: flex; align-items: center; gap: 4px; }
.btn-link-anexo:hover:not(:disabled) { color: var(--primary); }
.btn-link-anexo:disabled { opacity: 0.5; cursor: not-allowed; }

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