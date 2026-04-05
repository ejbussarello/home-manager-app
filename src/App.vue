<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc, updateDoc, getDocs, where, arrayUnion, limit, setDoc, getDoc } from 'firebase/firestore'
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, updatePassword, updateEmail } from 'firebase/auth'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage' 
import { db, auth, storage } from './firebase' 

import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler } from 'chart.js'
import { Doughnut, Line } from 'vue-chartjs'
import emailjs from '@emailjs/browser'
import confetti from 'canvas-confetti' 
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler)

// ==========================================
// ESTADOS GLOBAIS E TEMA
// ==========================================
const usuarioLogado = ref(null)
const dadosUsuarioFirestore = ref({}) 
const carregandoAuth = ref(true)
const familiaAtual = ref(null) 
const isPremiumPlano = ref(false)
const sidebarAberta = ref(true)

const paletaCor = ref('azul') 

let unsubTransacoes = null; let unsubCategorias = null; let unsubContas = null;
let unsubMetas = null; let unsubDividas = null; let unsubAuditoria = null; 

const extrairNome = (str) => {
  if(!str) return '';
  const parte = str.split('@')[0];
  return parte.charAt(0).toUpperCase() + parte.slice(1);
};

// ==========================================
// SISTEMA DE NOTIFICAÇÕES (TOAST)
// ==========================================
const notificacao = ref({ mostrar: false, mensagem: '', tipo: 'sucesso' });
let timerNotificacao = null;

const mostrarToast = (mensagem, tipo = 'sucesso') => {
  notificacao.value = { mostrar: true, mensagem, tipo };
  clearTimeout(timerNotificacao);
  timerNotificacao = setTimeout(() => { notificacao.value.mostrar = false; }, 3500); 
};

// ==========================================
// AUTENTICAÇÃO E PERFIL
// ==========================================
const modoLogin = ref('login') 
const authEmail = ref(''); const authSenha = ref(''); const authNome = ref('');
const modalOnboarding = ref(false); const onboardingNome = ref('');

const loginComGoogle = async () => { const provider = new GoogleAuthProvider(); try { await signInWithPopup(auth, provider); } catch (error) { mostrarToast("Erro ao entrar com Google.", "erro"); } }
const loginComEmail = async () => { try { await signInWithEmailAndPassword(auth, authEmail.value, authSenha.value); } catch (error) { mostrarToast("Erro ao fazer login. Verifique seus dados.", "erro"); } }
const cadastrarComEmail = async () => {
  if(!authNome.value || !authEmail.value || !authSenha.value) { mostrarToast("Preencha todos os campos.", "erro"); return; }
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, authEmail.value, authSenha.value);
    await updateProfile(userCredential.user, { displayName: authNome.value });
    usuarioLogado.value = { ...userCredential.user, displayName: authNome.value };
  } catch (error) { mostrarToast("Erro ao cadastrar a conta.", "erro"); }
}
const fazerLogout = async () => { if(confirm("Tem certeza que deseja sair?")) { await signOut(auth); window.location.reload(); } }

const salvarOnboarding = async () => {
  if(!onboardingNome.value) return;
  try {
    await updateProfile(auth.currentUser, { displayName: onboardingNome.value });
    usuarioLogado.value = { ...auth.currentUser, displayName: onboardingNome.value };
    modalOnboarding.value = false; verificarFamiliaOuCriar(); 
  } catch (error) { mostrarToast("Erro ao salvar seu nome.", "erro"); }
}

const modalPerfil = ref(false);
const perfilNome = ref(''); const perfilEmail = ref(''); const perfilNascimento = ref('');
const perfilSexo = ref(''); const perfilNovaSenha = ref(''); const perfilPaleta = ref('azul'); 

const isGoogleProvider = computed(() => { return usuarioLogado.value?.providerData.some(p => p.providerId === 'google.com'); });

const abrirModalPerfil = async () => {
  try {
    perfilNome.value = usuarioLogado.value.displayName || ''; perfilEmail.value = usuarioLogado.value.email || '';
    perfilNovaSenha.value = ''; perfilPaleta.value = paletaCor.value; modalPerfil.value = true;
    try {
      const docSnap = await getDoc(doc(db, "usuarios", usuarioLogado.value.uid));
      if (docSnap.exists()) { perfilNascimento.value = docSnap.data().nascimento || ''; perfilSexo.value = docSnap.data().sexo || ''; } 
      else { perfilNascimento.value = ''; perfilSexo.value = ''; }
    } catch (dbError) { console.warn("Aviso:", dbError); }
  } catch (err) { mostrarToast("Erro ao tentar abrir o perfil.", "erro"); }
};

const salvarPerfil = async () => {
  try {
    if (perfilNome.value !== usuarioLogado.value.displayName) { await updateProfile(auth.currentUser, { displayName: perfilNome.value }); usuarioLogado.value.displayName = perfilNome.value; }
    if (!isGoogleProvider.value) {
      if (perfilEmail.value !== usuarioLogado.value.email) { await updateEmail(auth.currentUser, perfilEmail.value); usuarioLogado.value.email = perfilEmail.value; }
      if (perfilNovaSenha.value && perfilNovaSenha.value.length >= 6) { await updatePassword(auth.currentUser, perfilNovaSenha.value); }
    }
    await setDoc(doc(db, "usuarios", usuarioLogado.value.uid), { nascimento: perfilNascimento.value, sexo: perfilSexo.value, paleta: perfilPaleta.value }, { merge: true });
    paletaCor.value = perfilPaleta.value; modalPerfil.value = false; mostrarToast("Perfil atualizado com sucesso!");
  } catch (error) { 
    if (error.code === 'auth/requires-recent-login') mostrarToast("Faça login novamente para alterar dados.", "erro");
    else mostrarToast("Erro ao atualizar perfil.", "erro"); 
  }
};

// ==========================================
// FAMÍLIA E AUDITORIA
// ==========================================
const isAdmin = computed(() => {
  if (!familiaAtual.value || !usuarioLogado.value) return false;
  const adminEmail = familiaAtual.value.admin || familiaAtual.value.membros[0]; return adminEmail === usuarioLogado.value.email.toLowerCase();
});

const getColecao = (nomeColecao) => collection(doc(db, "familias", familiaAtual.value.id), nomeColecao);
const getDocRef = (nomeColecao, id) => doc(db, "familias", familiaAtual.value.id, nomeColecao, id);

const historicoAuditoria = ref([])
const registrarAuditoria = async (acao, detalhes) => {
  if (!familiaAtual.value || !usuarioLogado.value) return;
  try { await addDoc(getColecao("auditoria"), { dataHora: new Date().toISOString(), usuarioEmail: usuarioLogado.value.email, usuarioNome: usuarioLogado.value.displayName.split(' ')[0], acao: acao, detalhes: detalhes }); } catch(e) {}
}
const formatarDataHora = (isoString) => {
  if (!isoString) return ''; const data = new Date(isoString); return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const criarFamilia = async () => {
  try {
    const emailUser = usuarioLogado.value.email.toLowerCase();
    const docRef = await addDoc(collection(db, "familias"), { nome: `Família de ${usuarioLogado.value.displayName.split(' ')[0]}`, membros: [emailUser], admin: emailUser });
    familiaAtual.value = { id: docRef.id, nome: `Família de ${usuarioLogado.value.displayName.split(' ')[0]}`, membros: [emailUser], admin: emailUser };
    iniciarListenersDaFamilia(docRef.id); registrarAuditoria("Criou a Conta", "Ambiente inicializado."); telaAtual.value = 'dashboard'; mostrarToast("Cofre financeiro criado!");
  } catch (e) { mostrarToast("Erro ao criar ambiente.", "erro"); }
}

const emailConvite = ref(''); const statusEnvio = ref(''); 
const convidarMembro = async () => {
  if (!isAdmin.value) { mostrarToast("Apenas o administrador pode convidar.", "erro"); return; }
  if (!emailConvite.value || !emailConvite.value.includes('@')) return;
  const emailFormatado = emailConvite.value.toLowerCase().trim();
  if (familiaAtual.value.membros.includes(emailFormatado)) { mostrarToast("E-mail já cadastrado!", "erro"); return; }
  statusEnvio.value = 'Enviando...';
  try {
    const novosMembros = [...familiaAtual.value.membros, emailFormatado];
    await updateDoc(doc(db, "familias", familiaAtual.value.id), { membros: novosMembros }); familiaAtual.value.membros = novosMembros;
    const linkApp = window.location.origin; await emailjs.send('SEU_SERVICE_ID', 'SEU_TEMPLATE_ID', { to_email: emailFormatado, link_app: linkApp }, 'SUA_PUBLIC_KEY');
    registrarAuditoria("Convidou Membro", `E-mail: ${emailFormatado}`); emailConvite.value = ''; statusEnvio.value = ''; mostrarToast(`Convite enviado para ${emailFormatado}!`);
  } catch (e) { statusEnvio.value = ''; mostrarToast("Membro adicionado, mas erro ao enviar e-mail.", "erro"); }
}
const removerMembro = async (emailParaRemover) => {
  if (!isAdmin.value) return; if (emailParaRemover === usuarioLogado.value.email) return;
  if(confirm(`Remover o acesso de ${emailParaRemover}?`)) {
    const novosMembros = familiaAtual.value.membros.filter(e => e !== emailParaRemover);
    await updateDoc(doc(db, "familias", familiaAtual.value.id), { membros: novosMembros }); familiaAtual.value.membros = novosMembros;
    registrarAuditoria("Removeu Membro", `E-mail revogado: ${emailParaRemover}`); mostrarToast("Acesso removido.");
  }
}

const iniciarListenersDaFamilia = (familiaId) => {
  const pastaFamilia = doc(db, "familias", familiaId);
  unsubTransacoes = onSnapshot(query(collection(pastaFamilia, "transacoes"), orderBy("data", "desc")), (qs) => { const listaT = []; qs.forEach((d) => listaT.push({ id: d.id, ...d.data() })); transacoes.value = listaT; });
  unsubCategorias = onSnapshot(query(collection(pastaFamilia, "categorias"), orderBy("nome", "asc")), (qs) => { const listaC = []; qs.forEach((d) => listaC.push({ id: d.id, nome: d.data().nome, subcategorias: d.data().subcategorias || [], limiteMensal: d.data().limiteMensal || 0 })); categoriasDisponiveis.value = listaC; });
  unsubContas = onSnapshot(query(collection(pastaFamilia, "contas"), orderBy("nome", "asc")), (qs) => { const listaContas = []; qs.forEach((d) => listaContas.push({ id: d.id, nome: d.data().nome, tipo: d.data().tipo, limite: d.data().limite || 0, diaFechamento: d.data().diaFechamento || 31, diaVencimento: d.data().diaVencimento || 10 })); contasDisponiveis.value = listaContas; });
  unsubMetas = onSnapshot(query(collection(pastaFamilia, "metas"), orderBy("nome", "asc")), (qs) => { const listaM = []; qs.forEach((d) => listaM.push({ id: d.id, ...d.data() })); metas.value = listaM; });
  unsubDividas = onSnapshot(query(collection(pastaFamilia, "dividasFixas"), orderBy("diaVencimento", "asc")), (qs) => { const listaD = []; qs.forEach((d) => listaD.push({ id: d.id, ...d.data() })); dividasFixas.value = listaD; });
  unsubAuditoria = onSnapshot(query(collection(pastaFamilia, "auditoria"), orderBy("dataHora", "desc"), limit(100)), (qs) => { const listaA = []; qs.forEach((d) => listaA.push({ id: d.id, ...d.data() })); historicoAuditoria.value = listaA; });
}

// ==========================================
// MENUS E FILTROS DE MÊS
// ==========================================
const telaAtual = ref('dashboard'); const temaEscuro = ref(false); const alternarTema = () => temaEscuro.value = !temaEscuro.value;
const mostrarFormulario = ref(false);
const alternarFormulario = () => { mostrarFormulario.value = !mostrarFormulario.value; window.scrollTo({ top: 0, behavior: 'smooth' }); }
const menuLancamentosAberto = ref(true)

const abrirFormularioRapido = (tipoSelecionado) => {
  telaAtual.value = 'lancamentos'; mostrarFormulario.value = true; tipo.value = 'despesa'; 
  setTimeout(() => { tipo.value = tipoSelecionado; window.scrollTo({ top: 0, behavior: 'smooth' }); }, 50);
}

const mesAtualYMD = new Date().toISOString().slice(0, 7); const mesFiltro = ref(mesAtualYMD);
const alterarMes = (delta) => {
  let [ano, mes] = mesFiltro.value.split('-').map(Number); mes += delta;
  if (mes > 12) { mes = 1; ano += 1; } if (mes < 1) { mes = 12; ano -= 1; }
  mesFiltro.value = `${ano}-${String(mes).padStart(2, '0')}`;
};
const mesFormatado = computed(() => {
  if (!mesFiltro.value) return ''; const [ano, mes] = mesFiltro.value.split('-'); const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return `${meses[parseInt(mes) - 1]} ${ano}`;
});

// ==========================================
// MÓDULOS: DESPESAS FIXAS, METAS E CATEGORIAS
// ==========================================
const dividasFixas = ref([]); const novaDividaNome = ref(''); const novaDividaValor = ref(''); const novaDividaDia = ref(10); const dividaCategoria = ref(''); const dividaSubcategoria = ref('');
const subcategoriasDividaDropdown = computed(() => { const cat = categoriasDisponiveis.value.find(c => c.nome === dividaCategoria.value); return cat ? cat.subcategorias : []; });
watch(dividaCategoria, () => { if (subcategoriasDividaDropdown.value.length > 0) dividaSubcategoria.value = subcategoriasDividaDropdown.value[0]; else dividaSubcategoria.value = ''; });
const adicionarDividaFixa = async () => {
  if (!novaDividaNome.value || !novaDividaValor.value || !dividaCategoria.value) return;
  try {
    await addDoc(getColecao("dividasFixas"), { nome: novaDividaNome.value.trim(), valor: parseFloat(novaDividaValor.value), diaVencimento: parseInt(novaDividaDia.value), categoria: dividaCategoria.value, subcategoria: dividaSubcategoria.value || '', pagamentos: [] });
    registrarAuditoria("Criou Despesa Fixa", `${novaDividaNome.value} - ${formatarMoeda(novaDividaValor.value)}`); novaDividaNome.value = ''; novaDividaValor.value = ''; novaDividaDia.value = 10; mostrarToast("Despesa fixa cadastrada!");
  } catch(e) { mostrarToast("Erro ao criar despesa fixa.", "erro"); }
}
const removerDividaFixa = async (id) => { const d = dividasFixas.value.find(x => x.id === id); if(confirm("Excluir esta despesa fixa?")) { await deleteDoc(getDocRef("dividasFixas", id)); if (d) registrarAuditoria("Apagou Despesa Fixa", d.nome); mostrarToast("Conta excluída."); } }
const editarValorDivida = async (divida) => {
  const novoValorStr = prompt(`Novo valor base para ${divida.nome} (R$):`, divida.valor); if (!novoValorStr) return; const novoValor = parseFloat(novoValorStr.replace(',', '.'));
  if (novoValor > 0) { await updateDoc(getDocRef("dividasFixas", divida.id), { valor: novoValor }); registrarAuditoria("Alterou Valor Fixo", `${divida.nome} alterado para ${formatarMoeda(novoValor)}`); mostrarToast("Valor atualizado!");}
}
const dividaSendoPaga = ref(null); 
const iniciarPagamentoFixo = (divida) => {
  abrirFormularioRapido('despesa'); descricao.value = `Pagamento: ${divida.nome}`; valor.value = divida.valor; categoriaSelecionada.value = divida.categoria; subcategoriaSelecionada.value = divida.subcategoria || ''; responsavel.value = usuarioLogado.value.email.toLowerCase(); 
  const hj = new Date(); dataLancamento.value = `${hj.getFullYear()}-${String(hj.getMonth() + 1).padStart(2, '0')}-${String(divida.diaVencimento).padStart(2, '0')}`; dividaSendoPaga.value = divida.id; 
}
const contasVencendo = computed(() => {
  if (!isPremiumPlano.value) return [];
  const hj = new Date(); const diaAtual = hj.getDate(); const mesAnoAtual = hj.toISOString().slice(0, 7); 
  return dividasFixas.value.filter(d => !d.pagamentos || !d.pagamentos.includes(mesAnoAtual)).map(d => {
      const diasRestantes = d.diaVencimento - diaAtual; let status = ''; let corClass = '';
      if (diasRestantes < 0) { status = 'Atrasado!'; corClass = 'texto-vermelho'; } else if (diasRestantes === 0) { status = 'Vence HOJE!'; corClass = 'texto-vermelho'; } else if (diasRestantes <= 3) { status = `Vence em ${diasRestantes} dias`; corClass = 'texto-laranja'; } else { status = `Dia ${d.diaVencimento}`; corClass = 'text-muted'; }
      return { ...d, diasRestantes, status, corClass };
    }).filter(d => d.diasRestantes <= 3).sort((a, b) => a.diasRestantes - b.diasRestantes);
});

const metas = ref([]); const novaMetaNome = ref(''); const novaMetaObjetivo = ref(''); const novaMetaAtual = ref('');
const metasPendentes = computed(() => metas.value.filter(m => m.valorAtual < m.valorObjetivo));
const adicionarMeta = async () => {
  if (!novaMetaNome.value || !novaMetaObjetivo.value) return; const objetivo = parseFloat(novaMetaObjetivo.value); if (objetivo <= 0) return;
  try {
    await addDoc(getColecao("metas"), { nome: novaMetaNome.value.trim(), valorObjetivo: objetivo, valorAtual: parseFloat(novaMetaAtual.value || 0) });
    registrarAuditoria("Criou Meta", `${novaMetaNome.value.trim()} - Objetivo: ${formatarMoeda(objetivo)}`); novaMetaNome.value = ''; novaMetaObjetivo.value = ''; novaMetaAtual.value = ''; mostrarToast("Objetivo financeiro criado!");
  } catch(e) { mostrarToast("Erro ao criar meta.", "erro"); }
}
const removerMeta = async (id) => { const m = metas.value.find(x => x.id === id); if(confirm("Excluir esta meta?")) { await deleteDoc(getDocRef("metas", id)); if (m) registrarAuditoria("Apagou Meta", m.nome); mostrarToast("Meta excluída.");} }
const iniciarAporte = (meta) => { abrirFormularioRapido('meta'); metaSelecionada.value = meta.id; responsavel.value = usuarioLogado.value.email.toLowerCase(); descricao.value = `Aporte: ${meta.nome}`; }

const categoriasDisponiveis = ref([]); const novaCategoria = ref(''); const inputsSubcategoria = ref({}); 
const adicionarCategoria = async () => { if (!novaCategoria.value) return; try { await addDoc(getColecao("categorias"), { nome: novaCategoria.value.trim(), subcategorias: [], limiteMensal: 0 }); registrarAuditoria("Adicionou Categoria", novaCategoria.value.trim()); novaCategoria.value = ''; mostrarToast("Categoria criada!"); } catch (e) {} }
const removerCategoria = async (id) => { const c = categoriasDisponiveis.value.find(x => x.id === id); await deleteDoc(getDocRef("categorias", id)); if (c) registrarAuditoria("Apagou Categoria", c.nome); mostrarToast("Categoria excluída."); }
const definirLimite = async (categoria) => {
  const limiteStr = prompt(`Limite mensal para "${categoria.nome}" (R$):`, categoria.limiteMensal || ''); if (limiteStr === null) return; 
  const novoLim = parseFloat(limiteStr.replace(',', '.')) || 0; await updateDoc(getDocRef("categorias", categoria.id), { limiteMensal: novoLim }); registrarAuditoria("Alterou Limite de Categoria", `${categoria.nome} - Novo Teto: ${formatarMoeda(novoLim)}`); mostrarToast("Limite atualizado!");
}
const adicionarSubcategoria = async (categoria) => { const novaSub = inputsSubcategoria.value[categoria.id]; if (!novaSub) return; await updateDoc(getDocRef("categorias", categoria.id), { subcategorias: [...categoria.subcategorias, novaSub] }); inputsSubcategoria.value[categoria.id] = ''; mostrarToast("Subcategoria adicionada!"); }
const removerSubcategoria = async (categoria, subRemover) => { await updateDoc(getDocRef("categorias", categoria.id), { subcategorias: categoria.subcategorias.filter(s => s !== subRemover) }); }


// ==========================================
// GESTÃO DE CONTAS E CARTÕES DE CRÉDITO
// ==========================================
const contasDisponiveis = ref([]); const novaContaNome = ref(''); const novaContaTipo = ref('Conta Bancária'); const novoCartaoLimite = ref(''); const novoCartaoFechamento = ref(1); const novoCartaoVencimento = ref(10);
const adicionarConta = async () => {
  if (!novaContaNome.value) return; const existe = contasDisponiveis.value.find(c => c.nome.toLowerCase() === novaContaNome.value.toLowerCase());
  if (!existe) {
    try {
      const objConta = { nome: novaContaNome.value.trim(), tipo: novaContaTipo.value };
      if (novaContaTipo.value === 'Cartão de Crédito' && isPremiumPlano.value) { objConta.limite = parseFloat(novoCartaoLimite.value) || 0; objConta.diaFechamento = parseInt(novoCartaoFechamento.value) || 1; objConta.diaVencimento = parseInt(novoCartaoVencimento.value) || 10; }
      await addDoc(getColecao("contas"), objConta); registrarAuditoria("Adicionou Conta", `${objConta.nome} (${objConta.tipo})`);
      novaContaNome.value = ''; novoCartaoLimite.value = ''; novoCartaoFechamento.value = 1; novoCartaoVencimento.value = 10; mostrarToast("Conta adicionada!");
    } catch (e) { mostrarToast("Erro ao adicionar conta.", "erro"); }
  } else mostrarToast("Esta conta já existe.", "erro");
}
const removerConta = async (id) => { const c = contasDisponiveis.value.find(x => x.id === id); await deleteDoc(getDocRef("contas", id)); if (c) registrarAuditoria("Apagou Conta", c.nome); mostrarToast("Conta excluída."); }
const editarConta = async (conta) => {
  const novoNome = prompt("Novo nome:", conta.nome); if (!novoNome || novoNome.trim() === "" || novoNome === conta.nome) return;
  try {
    await updateDoc(getDocRef("contas", conta.id), { nome: novoNome.trim() }); registrarAuditoria("Renomeou Conta", `De '${conta.nome}' para '${novoNome.trim()}'`);
    const qs = await getDocs(query(getColecao("transacoes"), where("conta", "==", conta.nome))); qs.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { conta: novoNome.trim() }));
    const qsDestino = await getDocs(query(getColecao("transacoes"), where("contaDestino", "==", conta.nome))); qsDestino.forEach(async (d) => await updateDoc(getDocRef("transacoes", d.id), { contaDestino: novoNome.trim() }));
    mostrarToast("Conta renomeada!");
  } catch (e) { mostrarToast("Erro ao editar conta.", "erro"); }
}

const cartoesCadastrados = computed(() => contasDisponiveis.value.filter(c => c.tipo === 'Cartão de Crédito'));
const outrasContasCadastradas = computed(() => contasDisponiveis.value.filter(c => c.tipo !== 'Cartão de Crédito'));

const getCartaoStatusGlobal = (cartao) => {
  let totalGasto = 0; let totalPago = 0;
  transacoes.value.forEach(t => { if (t.conta === cartao.nome && t.tipo === 'despesa') totalGasto += t.valor; if (t.contaDestino === cartao.nome && t.tipo === 'transferencia') totalPago += t.valor; });
  const limiteDisponivel = (cartao.limite || 0) - (totalGasto - totalPago); return { limiteDisponivel, limiteTotal: cartao.limite || 0 };
};

const calcularDataFatura = (dataCompra, fechamento, vencimento, parcelasAdicionais) => {
  let [ano, mes, dia] = dataCompra.split('-').map(Number); let mesFatura = mes; let anoFatura = ano;
  if (dia >= fechamento) { mesFatura++; if (mesFatura > 12) { mesFatura = 1; anoFatura++; } }
  mesFatura += parcelasAdicionais; while (mesFatura > 12) { mesFatura -= 12; anoFatura++; }
  let mesVencimento = mesFatura; let anoVencimento = anoFatura;
  if (vencimento < fechamento) { mesVencimento++; if (mesVencimento > 12) { mesVencimento = 1; anoVencimento++; } }
  return `${anoVencimento}-${String(mesVencimento).padStart(2, '0')}-${String(vencimento).padStart(2, '0')}`;
}

const getFaturaDetalhada = (cartao, mesYMD) => {
  let [ano, mes] = mesYMD.split('-').map(Number); let fechamento = cartao.diaFechamento || 31;
  let dataFechamentoAtual = new Date(ano, mes - 1, fechamento); let strFechamentoAtual = `${dataFechamentoAtual.getFullYear()}-${String(dataFechamentoAtual.getMonth() + 1).padStart(2, '0')}-${String(dataFechamentoAtual.getDate()).padStart(2, '0')}`;

  let totalFatura = 0; let transacoesFatura = [];
  transacoes.value.forEach(t => { if (t.conta === cartao.nome && t.tipo === 'despesa' && t.data && t.data.startsWith(mesYMD)) { totalFatura += t.valor; transacoesFatura.push(t); } });
  let totalPago = 0; transacoes.value.forEach(t => { if (t.tipo === 'transferencia' && t.contaDestino === cartao.nome && t.faturaMes === mesYMD) totalPago += t.valor; });

  const hojeStr = new Date().toISOString().slice(0, 10); const isFechada = hojeStr > strFechamentoAtual;
  const pagoEfetivo = Math.round(totalPago * 100); const faturaEfetiva = Math.round(totalFatura * 100);
  return { total: totalFatura, transacoes: transacoesFatura.sort((a, b) => ((a.dataCompra || a.data) || '').localeCompare((b.dataCompra || b.data) || '')), pago: pagoEfetivo >= faturaEfetiva && faturaEfetiva > 0, valorPago: totalPago, isFechada: isFechada, dataFechamento: strFechamentoAtual };
};

const modalPagarFatura = ref(false); const cartaoAlvoPagamento = ref(null); const valorFaturaPagamento = ref(0); const contaOrigemPagamentoFatura = ref('');
const iniciarPagamentoFatura = (cartao, valor) => { cartaoAlvoPagamento.value = cartao; valorFaturaPagamento.value = Number(valor.toFixed(2)); modalPagarFatura.value = true; };
const confirmarPagamentoFatura = async () => {
  if (!contaOrigemPagamentoFatura.value) { mostrarToast("Selecione a conta de origem!", "erro"); return; }
  try {
    const hj = new Date().toISOString().slice(0, 10);
    await addDoc(getColecao("transacoes"), { tipo: 'transferencia', descricao: `Pagamento Fatura ${mesFormatado.value}`, responsavel: usuarioLogado.value.email.toLowerCase(), beneficiario: usuarioLogado.value.email.toLowerCase(), conta: contaOrigemPagamentoFatura.value, contaDestino: cartaoAlvoPagamento.value.nome, data: hj, valor: valorFaturaPagamento.value, faturaMes: mesFiltro.value });
    registrarAuditoria("Pagou Fatura", `${cartaoAlvoPagamento.value.nome} (${mesFormatado.value}) - Valor: ${formatarMoeda(valorFaturaPagamento.value)}`);
    modalPagarFatura.value = false; contaOrigemPagamentoFatura.value = ''; mostrarToast("Fatura paga! Limite restabelecido.");
  } catch(e) { mostrarToast("Erro ao processar pagamento da fatura.", "erro"); }
};

// ==========================================
// LANÇAMENTOS GERAIS
// ==========================================
const hoje = new Date().toISOString().slice(0, 10);
const tipo = ref('despesa'); const dataLancamento = ref(hoje); const descricao = ref(''); const valor = ref('');
const categoriaSelecionada = ref(''); const subcategoriaSelecionada = ref(''); const responsavel = ref(''); const beneficiario = ref('');
const contaSelecionada = ref(''); const contaDestinoSelecionada = ref(''); const metaSelecionada = ref(''); const transacoes = ref([]);
const arquivoComprovante = ref(null); const uploadProgresso = ref(false);
const isParcelado = ref(false); const numeroParcelas = ref(2); const dataPrimeiraParcela = ref(hoje);

const inputComprovanteOculto = ref(null); const transacaoAlvoAnexo = ref(null); const uploadingId = ref(null);
const abrirSeletorArquivo = (t) => { transacaoAlvoAnexo.value = t; if (inputComprovanteOculto.value) inputComprovanteOculto.value.click(); };
const processarAnexoPosterior = async (event) => {
  const arquivo = event.target.files[0]; if (!arquivo || !transacaoAlvoAnexo.value) return;
  const t = transacaoAlvoAnexo.value; uploadingId.value = t.id;
  try {
    const nomeArquivo = `${Date.now()}_${arquivo.name}`; const caminho = `familias/${familiaAtual.value.id}/comprovantes/${nomeArquivo}`; const arquivoRef = storageRef(storage, caminho);
    await uploadBytes(arquivoRef, arquivo); const url = await getDownloadURL(arquivoRef);
    await updateDoc(getDocRef("transacoes", t.id), { comprovanteUrl: url, comprovanteCaminho: caminho }); registrarAuditoria("Anexou Comprovante", `Em transação: ${t.descricao}`); mostrarToast("Anexo salvo com sucesso!");
  } catch (err) { mostrarToast("Erro ao enviar anexo.", "erro"); } finally { uploadingId.value = null; transacaoAlvoAnexo.value = null; event.target.value = ''; }
};

const subcategoriasDropdown = computed(() => { const cat = categoriasDisponiveis.value.find(c => c.nome === categoriaSelecionada.value); return cat ? cat.subcategorias : []; });
const isContaCartaoSelecionada = computed(() => { const c = contasDisponiveis.value.find(x => x.nome === contaSelecionada.value); return c && c.tipo === 'Cartão de Crédito'; });

watch(categoriaSelecionada, () => { if (subcategoriasDropdown.value.length > 0) subcategoriaSelecionada.value = subcategoriasDropdown.value[0]; else subcategoriaSelecionada.value = ''; });
watch(categoriasDisponiveis, (novaLista) => { if (novaLista.length > 0 && (!categoriaSelecionada.value || !novaLista.find(c => c.nome === categoriaSelecionada.value))) categoriaSelecionada.value = novaLista[0].nome; });
watch(contasDisponiveis, (novaLista) => {
  if (novaLista.length > 0) {
    if(!contaSelecionada.value || !novaLista.find(c => c.nome === contaSelecionada.value)) contaSelecionada.value = novaLista[0].nome;
    if(!contaDestinoSelecionada.value || !novaLista.find(c => c.nome === contaDestinoSelecionada.value)) contaDestinoSelecionada.value = novaLista[0].nome;
  }
});
watch(tipo, (novoTipo) => { if (novoTipo === 'meta') isParcelado.value = false; });

const calcularDataFutura = (dataBase, meses) => {
  const [a, m, d] = dataBase.split('-'); const dt = new Date(a, m - 1, d); const diaOrig = dt.getDate();
  dt.setMonth(dt.getMonth() + meses); if (dt.getDate() !== diaOrig) dt.setDate(0); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const soltarConfetes = () => { confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#10b981', '#3b82f6', '#f59e0b'], zIndex: 9999 }); };
const selecionarArquivo = (event) => { arquivoComprovante.value = event.target.files[0]; };

const adicionarTransacao = async () => {
  if (!descricao.value || !valor.value || !dataLancamento.value || !contaSelecionada.value || !responsavel.value) { mostrarToast("Preencha todos os campos obrigatórios.", "erro"); return; }
  const valBase = parseFloat(valor.value); const descLog = descricao.value; const tipoLog = tipo.value;
  const contaObj = contasDisponiveis.value.find(c => c.nome === contaSelecionada.value); const isCC = contaObj && contaObj.tipo === 'Cartão de Crédito';

  if (isCC && tipo.value === 'despesa') {
    const statusGlobal = getCartaoStatusGlobal(contaObj);
    if (valBase > statusGlobal.limiteDisponivel) { if(!confirm(`Atenção: Ultrapassa o limite do cartão. Forçar lançamento?`)) return; }
  }
  
  try {
    const transacaoObj = { tipo: tipo.value, descricao: descricao.value, responsavel: responsavel.value, conta: contaSelecionada.value };
    let urlDoArquivo = ''; let caminhoFisicoNoStorage = ''; 
    if (arquivoComprovante.value && isPremiumPlano.value) {
      uploadProgresso.value = true;
      try {
        const nomeArquivo = `${Date.now()}_${arquivoComprovante.value.name}`; caminhoFisicoNoStorage = `familias/${familiaAtual.value.id}/comprovantes/${nomeArquivo}`;
        const arquivoRef = storageRef(storage, caminhoFisicoNoStorage); await uploadBytes(arquivoRef, arquivoComprovante.value); urlDoArquivo = await getDownloadURL(arquivoRef);
      } catch (err) { console.error(err); mostrarToast("Erro no Storage de anexos.", "erro"); }
      uploadProgresso.value = false;
    }
    if (urlDoArquivo) { transacaoObj.comprovanteUrl = urlDoArquivo; transacaoObj.comprovanteCaminho = caminhoFisicoNoStorage; }

    if (tipo.value === 'meta') {
      let valorRestante = valBase; let indiceAtual = metasPendentes.value.findIndex(m => m.id === metaSelecionada.value);
      if (indiceAtual === -1) indiceAtual = 0; if (metasPendentes.value.length === 0) { mostrarToast("Todas as metas já foram atingidas!", "erro"); return; }
      while (valorRestante > 0 && indiceAtual < metasPendentes.value.length) {
        const metaCorrente = metasPendentes.value[indiceAtual]; const falta = metaCorrente.valorObjetivo - metaCorrente.valorAtual;
        if (falta > 0) {
          const aporte = Math.min(valorRestante, falta);
          await addDoc(getColecao("transacoes"), { ...transacaoObj, data: dataLancamento.value, valor: aporte, metaId: metaCorrente.id, nomeMeta: metaCorrente.nome });
          await updateDoc(getDocRef("metas", metaCorrente.id), { valorAtual: metaCorrente.valorAtual + aporte });
          if (aporte === falta) soltarConfetes(); valorRestante -= aporte;
        }
        if (valorRestante > 0) indiceAtual++;
      }
    } else {
      if (tipo.value === 'transferencia') { transacaoObj.beneficiario = beneficiario.value; transacaoObj.contaDestino = contaDestinoSelecionada.value; } 
      else { transacaoObj.categoria = categoriaSelecionada.value; transacaoObj.subcategoria = subcategoriaSelecionada.value || ''; }

      if (isParcelado.value) {
        const qtd = parseInt(numeroParcelas.value); let shiftFatura = 0;
        if (isCC) {
            let dataPrimeiraFatura = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, 0);
            if (getFaturaDetalhada(contaObj, dataPrimeiraFatura.slice(0,7)).pago) shiftFatura = 1;
        }
        for (let i = 0; i < qtd; i++) {
          let dataParcela = calcularDataFutura(dataPrimeiraParcela.value, i);
          if (isCC) dataParcela = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, i + shiftFatura);
          await addDoc(getColecao("transacoes"), { ...transacaoObj, descricao: `${descricao.value} (${i + 1}/${qtd})`, valor: valBase / qtd, data: dataParcela, dataCompra: dataLancamento.value });
        }
      } else {
        let dataRegistro = dataLancamento.value;
        if (isCC) {
          dataRegistro = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, 0);
          if (getFaturaDetalhada(contaObj, dataRegistro.slice(0,7)).pago) dataRegistro = calcularDataFatura(dataLancamento.value, contaObj.diaFechamento, contaObj.diaVencimento, 1);
        }
        await addDoc(getColecao("transacoes"), { ...transacaoObj, valor: valBase, data: dataRegistro, dataCompra: dataLancamento.value });
      }
    }
    
    if (dividaSendoPaga.value) {
      const mesRegistro = dataLancamento.value.slice(0, 7); 
      await updateDoc(getDocRef("dividasFixas", dividaSendoPaga.value), { pagamentos: arrayUnion(mesRegistro) }); dividaSendoPaga.value = null; 
    }

    registrarAuditoria("Novo Registro", `${tipoLog.toUpperCase()}: ${descLog} - Valor: ${formatarMoeda(valBase)}`);
    mostrarToast("Lançamento salvo com sucesso!");

    descricao.value = ''; valor.value = ''; isParcelado.value = false; numeroParcelas.value = 2; arquivoComprovante.value = null;
    if(document.getElementById("input-comprovante")) document.getElementById("input-comprovante").value = "";
    mostrarFormulario.value = false; 
  } catch (e) { mostrarToast("Falha no processo de gravação.", "erro"); uploadProgresso.value = false; }
}

const apagarTransacao = async (t) => { 
  if (confirm("Apagar registro permanentemente?")) {
    await deleteDoc(getDocRef("transacoes", t.id));
    if (t.comprovanteUrl && t.comprovanteCaminho) { try { await deleteObject(storageRef(storage, t.comprovanteCaminho)); } catch (err) {} }
    if (t.tipo === 'meta') { const metaObj = metas.value.find(m => m.id === t.metaId); if (metaObj) await updateDoc(getDocRef("metas", metaObj.id), { valorAtual: metaObj.valorAtual - t.valor }); }
    registrarAuditoria("Apagou Registro", `${t.tipo.toUpperCase()}: ${t.descricao} - Valor: ${formatarMoeda(t.valor)}`);
    mostrarToast("Registro apagado.");
  }
}

// ==========================================
// EXPORTAÇÃO E DASHBOARDS
// ==========================================
const transacoesFiltradas = computed(() => { return transacoes.value.filter(t => t.data && t.data.startsWith(mesFiltro.value)); });
const transacoesVisiveisTabela = computed(() => { return transacoesFiltradas.value.filter(t => { const conta = contasDisponiveis.value.find(c => c.nome === t.conta); return !(conta && conta.tipo === 'Cartão de Crédito'); });});
const ultimasComprasCartao = computed(() => { const nomesCartoes = contasDisponiveis.value.filter(c => c.tipo === 'Cartão de Crédito').map(c => c.nome); return transacoes.value.filter(t => t.tipo === 'despesa' && nomesCartoes.includes(t.conta)).sort((a, b) => ((b.dataCompra || b.data) || '').localeCompare((a.dataCompra || a.data) || '')).slice(0, 5); });

const exportarCSV = () => {
  if (transacoesFiltradas.value.length === 0) { mostrarToast("Nenhum dado para exportar.", "erro"); return; }
  let csv = 'Data;Descrição;Categoria/Meta;Conta Origem;Conta Destino;Responsável;Beneficiário;Tipo;Valor\n';
  transacoesFiltradas.value.forEach(t => { csv += `${formatarData(t.dataCompra || t.data)};${t.descricao.replace(/;/g, ',')};${t.tipo === 'meta' ? 'Meta: '+t.nomeMeta : t.categoria};${t.conta};${t.contaDestino||''};${extrairNome(t.responsavel)};${extrairNome(t.beneficiario)};${t.tipo.toUpperCase()};${t.valor.toString().replace('.', ',')}\n`; });
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' })); link.download = `HomeManager_${mesFiltro.value}.csv`; link.click();
  registrarAuditoria("Exportou Dados", `Formato CSV do mês ${mesFiltro.value}`);
};
const exportarPDF = () => {
  if (transacoesFiltradas.value.length === 0) { mostrarToast("Nenhum dado para exportar.", "erro"); return; }
  const doc = new jsPDF(); doc.setFontSize(16); doc.text(`Relatório: ${mesFormatado.value}`, 14, 20);
  const rows = transacoesFiltradas.value.map(t => [ formatarData(t.dataCompra || t.data), t.descricao, t.tipo === 'meta' ? `Meta: ${t.nomeMeta}` : t.categoria, t.conta, extrairNome(t.responsavel), `${t.tipo === 'despesa' ? '-' : '+'} ${formatarMoeda(t.valor)}` ]);
  autoTable(doc, { head: [["Data", "Descrição", "Categoria", "Conta", "Resp.", "Valor"]], body: rows, startY: 30, theme: 'striped', styles: { fontSize: 8 }, headStyles: { fillColor: [37, 99, 235] } }); doc.save(`HomeManager_${mesFiltro.value}.pdf`);
  registrarAuditoria("Exportou Dados", `Formato PDF do mês ${mesFiltro.value}`);
};

const transacoesAcumuladasAteMes = computed(() => { return transacoes.value.filter(t => t.data <= mesFiltro.value + '-31'); });
const despesasMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'despesa'));
const receitasMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'receita'));
const aportesMes = computed(() => transacoesFiltradas.value.filter(t => t.tipo === 'meta')); 

const totalReceitas = computed(() => receitasMes.value.reduce((a, t) => a + t.valor, 0));
const totalDespesas = computed(() => despesasMes.value.reduce((a, t) => a + t.valor, 0));
const totalAportes = computed(() => aportesMes.value.reduce((a, t) => a + t.valor, 0)); 
const saldoAtualMes = computed(() => totalReceitas.value - totalDespesas.value - totalAportes.value);

const orcamentosStatus = computed(() => {
  const gastosPorCategoria = {}; despesasMes.value.forEach(t => { gastosPorCategoria[t.categoria] = (gastosPorCategoria[t.categoria] || 0) + t.valor; });
  return categoriasDisponiveis.value.filter(c => c.limiteMensal && c.limiteMensal > 0).map(c => {
      const gasto = gastosPorCategoria[c.nome] || 0; const pct = (gasto / c.limiteMensal) * 100;
      return { nome: c.nome, limite: c.limiteMensal, gasto: gasto, percentual: pct, cor: pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981' };
    }).sort((a, b) => b.percentual - a.percentual); 
});

// PROJEÇÃO E DRE
const receitaMediaGeral = computed(() => {
  const hj = new Date(); let totalRec = 0; let mesesC = 0;
  for (let i = 1; i <= 3; i++) {
    let m = new Date(hj.getFullYear(), hj.getMonth() - i, 1); let prefix = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    let rec = transacoes.value.filter(t => t.tipo === 'receita' && t.data && t.data.startsWith(prefix)).reduce((a, b) => a + b.valor, 0); if (rec > 0) { totalRec += rec; mesesC++; }
  }
  if (mesesC === 0) { let prefixHj = `${hj.getFullYear()}-${String(hj.getMonth() + 1).padStart(2, '0')}`; return transacoes.value.filter(t => t.tipo === 'receita' && t.data && t.data.startsWith(prefixHj)).reduce((a, b) => a + b.valor, 0); }
  return totalRec / mesesC;
});
const saldoGeralReal = computed(() => {
  let totalRec = 0; let totalDesp = 0; const dataHojeStr = new Date().toISOString().slice(0, 10);
  transacoes.value.filter(t => t.data <= dataHojeStr).forEach(t => { if(t.tipo === 'receita') totalRec += t.valor; if(t.tipo === 'despesa' || t.tipo === 'meta') totalDesp += t.valor; }); return totalRec - totalDesp;
});
const dadosProjecao = computed(() => {
  let saldoBase = saldoGeralReal.value; const recMedia = receitaMediaGeral.value || 0; const despesasFixasSoma = dividasFixas.value.reduce((a,b) => a + b.valor, 0);
  const dados = []; let dataCorrente = new Date();
  for (let i = 1; i <= 6; i++) {
    let m = new Date(dataCorrente.getFullYear(), dataCorrente.getMonth() + i, 1); let prefix = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`; let nomeMesAno = m.toLocaleString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '');
    let parcelasPrevistas = transacoes.value.filter(t => t.data && t.data.startsWith(prefix) && (t.tipo === 'despesa' || t.tipo === 'meta')).reduce((a, b) => a + b.valor, 0);
    saldoBase = saldoBase + recMedia - despesasFixasSoma - parcelasPrevistas;
    dados.push({ mes: nomeMesAno.charAt(0).toUpperCase() + nomeMesAno.slice(1), prefix: prefix, receitaMedia: recMedia, fixas: despesasFixasSoma, parcelas: parcelasPrevistas, saldoPrevisto: saldoBase });
  } return dados;
});
const chartDataProjecao = computed(() => { return { labels: dadosProjecao.value.map(d => d.mes), datasets: [{ label: 'Saldo Acumulado (Previsto)', data: dadosProjecao.value.map(d => d.saldoPrevisto), borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.4, pointRadius: 5, pointBorderColor: '#fff', pointBackgroundColor: dadosProjecao.value.map(d => d.saldoPrevisto >= 0 ? '#10b981' : '#ef4444') }] }});
const chartOptionsProjecao = computed(() => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(context) { return formatarMoeda(context.raw); } } } }, scales: { y: { ticks: { callback: function(value) { return 'R$ ' + value; } } } }}));

const anoDRE = ref(new Date().getFullYear().toString()); const alterarAnoDRE = (delta) => { anoDRE.value = (parseInt(anoDRE.value) + delta).toString(); }; const mesesCurtos = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const matrizDRE = computed(() => {
  const estrutura = { receitas: Array(12).fill(0), categorias: {}, metas: Array(12).fill(0), totalDespesas: Array(12).fill(0), saldo: Array(12).fill(0) };
  categoriasDisponiveis.value.forEach(c => { estrutura.categorias[c.nome] = Array(12).fill(0); });
  transacoes.value.filter(t => (t.dataCompra || t.data) && (t.dataCompra || t.data).startsWith(anoDRE.value)).forEach(t => { if (t.tipo === 'despesa' && t.categoria && !estrutura.categorias[t.categoria]) estrutura.categorias[t.categoria] = Array(12).fill(0); });
  transacoes.value.forEach(t => {
    const dataUsada = t.dataCompra || t.data; if (!dataUsada || !dataUsada.startsWith(anoDRE.value)) return; const mesIdx = parseInt(dataUsada.split('-')[1]) - 1;
    if (t.tipo === 'receita') estrutura.receitas[mesIdx] += t.valor;
    else if (t.tipo === 'despesa') { if(estrutura.categorias[t.categoria]) { estrutura.categorias[t.categoria][mesIdx] += t.valor; estrutura.totalDespesas[mesIdx] += t.valor; } } 
    else if (t.tipo === 'meta') estrutura.metas[mesIdx] += t.valor;
  });
  for (let i = 0; i < 12; i++) estrutura.saldo[i] = estrutura.receitas[i] - estrutura.totalDespesas[i] - estrutura.metas[i];
  const listaCategorias = Object.keys(estrutura.categorias).map(cat => { const valores = estrutura.categorias[cat]; const total = valores.reduce((a,b) => a+b, 0); const media = total / 12; return { nome: cat, valores, total, media }; }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  const totaisAno = { receitas: estrutura.receitas.reduce((a,b)=>a+b, 0), despesas: estrutura.totalDespesas.reduce((a,b)=>a+b, 0), metas: estrutura.metas.reduce((a,b)=>a+b, 0), saldo: estrutura.saldo.reduce((a,b)=>a+b, 0) };
  return { ...estrutura, listaCategorias, totaisAno };
});

const verificarFamiliaOuCriar = async () => {
  try {
    const emailSeguro = usuarioLogado.value.email ? usuarioLogado.value.email.toLowerCase() : '';
    responsavel.value = emailSeguro; 
    const qFamilia = query(collection(db, "familias"), where("membros", "array-contains", emailSeguro));
    const querySnapshot = await getDocs(qFamilia);
    if (!querySnapshot.empty) {
      familiaAtual.value = { id: querySnapshot.docs[0].id, ...querySnapshot.docs[0].data() };
      iniciarListenersDaFamilia(familiaAtual.value.id); telaAtual.value = 'dashboard';
    } else telaAtual.value = 'sem_familia';
  } catch (err) {}
}

onMounted(() => {
  onAuthStateChanged(auth, async (user) => {
    try {
      if (user) {
        usuarioLogado.value = user;
        try { const docSnap = await getDoc(doc(db, "usuarios", user.uid)); if (docSnap.exists() && docSnap.data().paleta) paletaCor.value = docSnap.data().paleta; } catch (errDb) {}
        if (!user.displayName) { modalOnboarding.value = true; return; }
        await verificarFamiliaOuCriar();
      } else usuarioLogado.value = null; 
    } catch (e) {} finally { carregandoAuth.value = false; }
  });
});

const formatarMoeda = (val) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Math.abs(val));
const formatarData = (d) => d ? d.split('-').reverse().join('/') : '';
</script>

<template>
  
  <div v-if="carregandoAuth" class="tela-loading"><div class="spinner"></div><p>Carregando...</p></div>

  <div v-else-if="modalOnboarding" class="modal-overlay blur-bg">
    <div class="cartao form-elegante modal-conteudo animacao-entrada text-center">
      <h2 class="titulo-clean mb-10">Bem-vindo(a)! 🎉</h2>
      <p class="text-muted mb-20">Para começarmos, como você gostaria de ser chamado(a)?</p>
      <form @submit.prevent="salvarOnboarding" class="formulario">
        <div class="campo"><input v-model="onboardingNome" type="text" placeholder="Seu nome ou apelido..." required style="text-align: center; font-size: 1.1rem;" /></div>
        <button type="submit" class="btn-salvar-elegante btn-cor-despesa mt-10">Acessar Meu Cofre</button>
      </form>
    </div>
  </div>

  <div v-else-if="!usuarioLogado" class="tela-login" :class="'paleta-' + paletaCor">
    <div class="login-card animacao-entrada">
      <div class="logo-login"><h2>HomeManager</h2><p>Inteligência financeira</p></div>
      <div class="toggle-login mb-20">
        <button :class="{'ativo': modoLogin === 'login'}" @click="modoLogin = 'login'">Entrar</button>
        <button :class="{'ativo': modoLogin === 'cadastro'}" @click="modoLogin = 'cadastro'">Criar Conta</button>
      </div>
      <form v-if="modoLogin === 'login'" @submit.prevent="loginComEmail" class="formulario text-left mb-20">
        <div class="campo"><label>E-mail</label><input v-model="authEmail" type="email" required /></div>
        <div class="campo"><label>Senha</label><input v-model="authSenha" type="password" required /></div>
        <button type="submit" class="btn-salvar-elegante mt-10" style="background:var(--primary);">Entrar</button>
      </form>
      <form v-if="modoLogin === 'cadastro'" @submit.prevent="cadastrarComEmail" class="formulario text-left mb-20">
        <div class="campo"><label>Como quer ser chamado?</label><input v-model="authNome" type="text" required /></div>
        <div class="campo"><label>E-mail</label><input v-model="authEmail" type="email" required /></div>
        <div class="campo"><label>Senha (Mín. 6 caracteres)</label><input v-model="authSenha" type="password" required minlength="6"/></div>
        <button type="submit" class="btn-salvar-elegante mt-10" style="background:var(--primary);">Criar Minha Conta</button>
      </form>
      <div class="ou-divisor text-muted text-sm mb-20"><span>ou</span></div>
      <button @click="loginComGoogle" class="btn-google">
        <img src="https://upload.wikimedia.org/wikipedia/commons/5/53/Google_%22G%22_Logo.svg" alt="Google" class="google-icon" />
        {{ modoLogin === 'login' ? 'Entrar com Google' : 'Cadastrar com Google' }}
      </button>
    </div>
  </div>

  <div v-else-if="telaAtual === 'sem_familia'" class="tela-login" :class="'paleta-' + paletaCor">
    <div class="login-card animacao-entrada" style="max-width: 500px;">
      <div class="logo-login"><h2>Bem-vindo, {{ usuarioLogado.displayName.split(' ')[0] }}!</h2></div>
      <button @click="criarFamilia" class="btn-salvar-elegante mt-10 mb-20" style="background:var(--primary);">Criar Meu Cofre Financeiro</button>
      <button @click="fazerLogout" class="btn-link text-danger" style="text-decoration:none;">Sair da Conta</button>
    </div>
  </div>

  <div v-else class="app-layout" :class="[temaEscuro ? 'tema-escuro' : 'tema-claro', 'paleta-' + paletaCor]">
    
    <div v-if="notificacao.mostrar" class="toast-notificacao animacao-toast" :class="notificacao.tipo === 'erro' ? 'toast-erro' : 'toast-sucesso'">
      <div class="toast-icone">{{ notificacao.tipo === 'erro' ? '⚠️' : '✅' }}</div>
      <div class="toast-mensagem">{{ notificacao.mensagem }}</div>
    </div>

    <header class="app-header">
      <div class="header-top">
        <div class="logo-app">
          <div class="emoji-logo">💼</div>
          <h2>HomeManager</h2>
        </div>
        <div class="header-actions">
          <button @click="alternarTema" class="btn-icon-soft" :title="temaEscuro ? 'Modo Claro' : 'Modo Escuro'">{{ temaEscuro ? '☀️' : '🌙' }}</button>
          <div class="profile-chip" @click="abrirModalPerfil">
            <img :src="usuarioLogado.photoURL || 'https://api.dicebear.com/7.x/initials/svg?seed=' + usuarioLogado.displayName" referrerpolicy="no-referrer" />
            <div class="profile-chip-info">
              <span>{{ usuarioLogado.displayName.split(' ')[0] }}</span>
              <small :class="isPremiumPlano ? 'text-primary' : 'text-muted'">{{ isPremiumPlano ? 'PRO' : 'FREE' }}</small>
            </div>
          </div>
        </div>
      </div>

      <nav class="header-nav">
        <button class="nav-btn" @click="telaAtual = 'dashboard'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'dashboard' }">📊 Dashboard</button>
        <button class="nav-btn" @click="telaAtual = 'lancamentos'" :class="{ ativo: telaAtual === 'lancamentos' }">📝 Lançamentos</button>
        <button class="nav-btn" @click="telaAtual = 'cartoes'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'cartoes' }">💳 Cartões e Contas</button>
        <button class="nav-btn" @click="telaAtual = 'fixas'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'fixas' }">📅 Fixas</button>
        <button class="nav-btn" @click="telaAtual = 'metas'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'metas' }">🎯 Metas</button>
        <button class="nav-btn" @click="telaAtual = 'categorias'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'categorias' }">📂 Categorias</button>
        <button class="nav-btn" @click="telaAtual = 'projecao'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'projecao' }">🔮 Projeção</button>
        <button class="nav-btn" @click="telaAtual = 'dre'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'dre' }">📈 DRE Anual</button>
        <button class="nav-btn" @click="telaAtual = 'familia'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'familia' }">👨‍👩‍👧‍👦 Família</button>
        <button class="nav-btn" @click="telaAtual = 'auditoria'; mostrarFormulario = false" :class="{ ativo: telaAtual === 'auditoria' }">🕵️‍♂️ Auditoria</button>
      </nav>
    </header>

    <main class="conteudo-principal">
      <div class="flex-header">
        <h1 class="titulo-pagina">
          {{ telaAtual === 'dashboard' ? 'Dashboard' : 
             telaAtual === 'cartoes' ? 'Cartões e Contas' : 
             telaAtual === 'fixas' ? 'Despesas Fixas' :
             telaAtual === 'metas' ? 'Metas e Objetivos' :
             telaAtual === 'lancamentos' ? 'Lançamentos' : 
             telaAtual === 'projecao' ? 'Fluxo de Caixa' : 
             telaAtual === 'dre' ? 'DRE Matricial' : 
             telaAtual === 'categorias' ? 'Categorias' : 
             telaAtual === 'auditoria' ? 'Auditoria' : 'Sua Família' }}
        </h1>
        
        <div class="navegador-mes" v-if="['dashboard', 'lancamentos', 'fixas', 'cartoes'].includes(telaAtual)">
          <button @click="alterarMes(-1)" class="btn-seta-sutil">&lt;</button>
          <span class="mes-display">{{ mesFormatado }}</span>
          <button @click="alterarMes(1)" class="btn-seta-sutil">&gt;</button>
        </div>
        <div class="navegador-mes" v-if="telaAtual === 'dre' && isPremiumPlano">
          <button @click="alterarAnoDRE(-1)" class="btn-seta-sutil">&lt;</button>
          <span class="mes-display">{{ anoDRE }}</span>
          <button @click="alterarAnoDRE(1)" class="btn-seta-sutil">&gt;</button>
        </div>
      </div>

      <div v-if="modalPerfil" class="modal-overlay blur-bg">
        <div class="cartao form-elegante modal-conteudo animacao-entrada">
          <div class="flex-header mb-15">
            <h2 class="titulo-clean mb-0">Seu Perfil</h2>
            <button @click="modalPerfil = false" class="btn-fechar">✖</button>
          </div>
          
          <form @submit.prevent="salvarPerfil" class="formulario">
            <div class="linha-campos">
              <div class="campo"><label>Nome / Apelido</label><input v-model="perfilNome" type="text" required /></div>
            </div>
            <div class="linha-campos mt-10">
              <div class="campo"><label>E-mail</label><input v-model="perfilEmail" type="email" required :disabled="isGoogleProvider" :title="isGoogleProvider ? 'Conectado via Google' : ''"/></div>
            </div>
            
            <div class="linha-campos mt-10">
              <div class="campo"><label>Data de Nascimento</label><input v-model="perfilNascimento" type="date" /></div>
              <div class="campo">
                <label>Sexo</label>
                <select v-model="perfilSexo">
                  <option value="">Prefiro não informar</option><option value="Masculino">Masculino</option><option value="Feminino">Feminino</option><option value="Outro">Outro</option>
                </select>
              </div>
            </div>

            <div class="linha-campos mt-10">
              <div class="campo">
                <label>Cor do Sistema (Tema)</label>
                <div class="seletor-cores">
                  <button type="button" @click="perfilPaleta = 'azul'" :class="{'cor-ativa': perfilPaleta === 'azul'}" class="btn-cor" style="background: #3b82f6;" title="Clássico"></button>
                  <button type="button" @click="perfilPaleta = 'verde'" :class="{'cor-ativa': perfilPaleta === 'verde'}" class="btn-cor" style="background: #10b981;" title="Natureza"></button>
                  <button type="button" @click="perfilPaleta = 'laranja'" :class="{'cor-ativa': perfilPaleta === 'laranja'}" class="btn-cor" style="background: #f97316;" title="Pôr do Sol"></button>
                  <button type="button" @click="perfilPaleta = 'roxo'" :class="{'cor-ativa': perfilPaleta === 'roxo'}" class="btn-cor" style="background: #8b5cf6;" title="Noturno"></button>
                  <button type="button" @click="perfilPaleta = 'rosa'" :class="{'cor-ativa': perfilPaleta === 'rosa'}" class="btn-cor" style="background: #ec4899;" title="Doce"></button>
                </div>
              </div>
            </div>

            <div class="linha-campos mt-10" v-if="!isGoogleProvider">
              <div class="campo"><label>Nova Senha (Em branco = manter)</label><input v-model="perfilNovaSenha" type="password" minlength="6" placeholder="******" /></div>
            </div>
            
            <div class="flex-header mt-20 mb-0" style="gap: 15px;">
               <button type="button" @click="fazerLogout" class="btn-link text-danger" style="text-decoration:none;">Sair da Conta</button>
               <button type="submit" class="btn-salvar-secundario" style="flex:1;">Salvar Alterações</button>
            </div>
          </form>
        </div>
      </div>

      <section v-if="telaAtual === 'dre'" class="tela-dre animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3.5rem; margin-bottom: 15px;">📊</div>
          <h2>Visão Anual e Sazonalidade</h2>
          <p class="text-muted mb-20" style="max-width: 500px; margin: 0 auto 25px;">O módulo DRE Matricial permite visualizar seu ano inteiro de ponta a ponta, entendendo a sazonalidade e extraindo médias automáticas de todos os seus gastos.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <div v-else class="cartao" style="padding: 20px; overflow-x: auto;">
          <div class="flex-header mb-20" style="margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid var(--borda);">
            <div><h2 class="titulo-clean mb-0">Visão Anual Matricial (Competência)</h2><p class="text-sm text-muted">Entenda sua sazonalidade de gastos mês a mês.</p></div>
          </div>
          
          <div class="tabela-responsiva">
            <table class="tabela tabela-dre">
              <thead>
                <tr>
                  <th class="col-fixa bg-table-header" style="border-top-left-radius: 12px;">Categoria</th>
                  <th v-for="m in mesesCurtos" :key="m" class="centro bg-table-header">{{ m }}</th>
                  <th class="centro col-destaque bg-table-header" style="border-left: 2px solid var(--borda);">TOTAL</th>
                  <th class="centro bg-table-header" style="border-top-right-radius: 12px;">MÉDIA</th>
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
                  <td class="col-fixa text-primary" style="background: var(--bg-cartao); border-bottom-left-radius: 12px;"><strong>RESULTADO DO MÊS (=)</strong></td>
                  <td v-for="(v, i) in matrizDRE.saldo" :key="i" class="centro font-weight-bold" :class="v >= 0 ? 'texto-verde' : 'texto-vermelho'" style="background: rgba(0,0,0,0.02);">{{ formatarMoeda(v) }}</td>
                  <td class="centro col-destaque font-weight-bold" :class="matrizDRE.totaisAno.saldo >= 0 ? 'texto-verde' : 'texto-vermelho'" style="background: rgba(0,0,0,0.05); border-left: 2px solid var(--borda);">{{ formatarMoeda(matrizDRE.totaisAno.saldo) }}</td>
                  <td class="centro font-weight-bold" style="background: rgba(0,0,0,0.02); border-bottom-right-radius: 12px;">{{ formatarMoeda(matrizDRE.totaisAno.saldo / 12) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'projecao'" class="tela-projecao animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3.5rem; margin-bottom: 15px;">🔮</div>
          <h2>Projeção de Fluxo de Caixa</h2>
          <p class="text-muted mb-20" style="max-width: 500px; margin: 0 auto 25px;">Pare de olhar apenas para o passado. O módulo de Projeção calcula suas receitas médias, abate faturas futuras e despesas fixas para prever o seu saldo dos próximos 6 meses.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <template v-else>
          <div class="cartao bento-item grafico-container" style="height: 340px; margin-bottom: 25px;">
            <h3 class="titulo-widget mb-0" style="border:none;">Futuro Financeiro (6 Meses)</h3>
            <p class="text-sm text-muted mb-20">Saldo atual + Receita média - Despesas fixas e faturas.</p>
            <div style="height: 230px;"><Line :data="chartDataProjecao" :options="chartOptionsProjecao" /></div>
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
                      <span class="etiqueta-admin" :style="{ backgroundColor: p.saldoPrevisto >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: p.saldoPrevisto >= 0 ? '#059669' : '#dc2626', border: 'none', fontSize: '0.85rem', padding: '6px 12px', borderRadius: '8px' }">
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
          <div style="font-size: 3.5rem; margin-bottom: 15px;">🕵️‍♂️</div>
          <h2>Auditoria da Família</h2>
          <p class="text-muted mb-20" style="max-width: 500px; margin: 0 auto 25px;">A confiança é tudo. A Auditoria grava um registro inalterável de quem apagou, editou ou criou cada lançamento no sistema.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <div v-else class="cartao">
          <div class="flex-header mb-20" style="margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid var(--borda);">
            <div><h2 class="titulo-clean mb-0">Histórico de Atividades</h2><p class="text-sm text-muted">Os últimos 100 registros são imutáveis.</p></div>
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

        <div class="cartao form-elegante mb-25">
          <h2 class="titulo-clean">Nova Conta ou Cartão</h2>
          <form @submit.prevent="adicionarConta" class="formulario">
            <div class="linha-campos">
              <div class="campo flex-grow"><input v-model="novaContaNome" type="text" placeholder="Nome da instituição (Ex: Nubank)..." required /></div>
              <div class="campo">
                <select v-model="novaContaTipo" required>
                  <option value="Cartão de Crédito" :disabled="!isPremiumPlano">Cartão de Crédito {{ !isPremiumPlano ? '🔒 PRO' : '' }}</option>
                  <option>Conta Bancária</option><option>Dinheiro Espécie</option><option>Vale Alimentação/Refeição</option>
                </select>
              </div>
            </div>
            <div v-if="novaContaTipo === 'Cartão de Crédito'" class="linha-campos mt-10 animacao-entrada" style="background:var(--input-bg); padding:20px; border-radius:16px;">
              <div class="campo"><label>Limite Total (R$)</label><input v-model="novoCartaoLimite" type="number" step="0.01" placeholder="Ex: 5000" required /></div>
              <div class="campo"><label>Dia do Fechamento</label><input v-model="novoCartaoFechamento" type="number" min="1" max="31" placeholder="Ex: 20" required /></div>
              <div class="campo"><label>Dia do Vencimento</label><input v-model="novoCartaoVencimento" type="number" min="1" max="31" placeholder="Ex: 27" required /></div>
            </div>
            <button type="submit" class="btn-salvar-secundario mt-10" style="max-width: 200px;">Adicionar Conta</button>
          </form>
        </div>

        <h3 class="titulo-sessao mt-30 mb-15">Cartões de Crédito</h3>
        
        <div v-if="!isPremiumPlano" class="cartao text-center mb-25" style="padding: 40px;">
          <div style="font-size: 2.5rem; margin-bottom: 10px;">💳</div>
          <h3 class="text-muted">Recurso Premium</h3>
          <p class="text-sm text-muted">A gestão inteligente de faturas de Cartão de Crédito, com rolagem automática de parcelas e recomposição de limites, é uma função exclusiva do plano PRO.</p>
        </div>

        <div v-else>
          <div v-if="cartoesCadastrados.length === 0" class="cartao vazio-widget mb-25">Nenhum cartão de crédito cadastrado.</div>
          <div v-else class="grid-metas mb-25">
            <div v-for="cartao in cartoesCadastrados" :key="cartao.id" class="cartao cartao-credito-widget">
              <div class="cartao-header">
                <h3 class="mb-0">{{ cartao.nome }}</h3>
                <div class="acoes-cartao">
                  <button @click="editarConta(cartao)" class="btn-icon-soft" title="Editar">✏️</button>
                  <button @click="removerConta(cartao.id)" class="btn-fechar" title="Excluir">✖</button>
                </div>
              </div>
              
              <div class="cartao-corpo mt-20">
                <div class="limite-info mb-10 text-sm">
                  <span class="text-muted">Limite Disponível</span>
                  <strong :class="getCartaoStatusGlobal(cartao).limiteDisponivel > 0 ? 'text-primary' : 'texto-vermelho'" style="font-size: 1.1rem;">{{ formatarMoeda(getCartaoStatusGlobal(cartao).limiteDisponivel) }}</strong>
                </div>
                
                <span class="text-sm text-muted">Fatura de {{ mesFormatado }}</span>
                <p class="valor-fatura mb-10">{{ formatarMoeda(getFaturaDetalhada(cartao, mesFiltro).total) }}</p>
                
                <div class="barra-progresso-fundo mb-10">
                  <div class="barra-progresso-preenchida" :style="{ width: Math.min((getFaturaDetalhada(cartao, mesFiltro).total / (cartao.limite || 1)) * 100, 100) + '%', backgroundColor: getFaturaDetalhada(cartao, mesFiltro).pago ? 'var(--receita)' : 'var(--laranja)' }"></div>
                </div>
                <div class="limite-info text-sm text-muted" style="display:flex; justify-content:space-between; align-items:center;">
                  <span>Total: {{ formatarMoeda(cartao.limite) }}</span>
                  <span>Vence dia {{ String(cartao.diaVencimento).padStart(2, '0') }}</span>
                </div>
              </div>

              <div class="cartao-footer mt-20">
                <span v-if="getFaturaDetalhada(cartao, mesFiltro).pago" class="tag-status paga" style="width: 100%;">Fatura Paga ✓</span>
                <template v-else-if="getFaturaDetalhada(cartao, mesFiltro).total > 0">
                  <button v-if="getFaturaDetalhada(cartao, mesFiltro).isFechada" @click="iniciarPagamentoFatura(cartao, getFaturaDetalhada(cartao, mesFiltro).total)" class="btn-salvar-secundario" style="width: 100%;">Pagar Fatura</button>
                  <span v-else class="tag-status aberta" style="width: 100%;">Aberta (Fecha dia {{ String(cartao.diaFechamento).padStart(2, '0') }})</span>
                </template>
                <span v-else class="tag-status zerada" style="width: 100%;">Fatura Zerada</span>
              </div>
              
              <details class="detalhes-fatura mt-20">
                <summary class="text-primary font-weight-bold" style="cursor:pointer; font-size:0.85rem;">Ver compras da fatura</summary>
                <div class="lista-compras mt-10">
                  <div v-if="getFaturaDetalhada(cartao, mesFiltro).transacoes.length === 0" class="text-muted text-sm">Nenhuma compra neste ciclo.</div>
                  <div v-for="t in getFaturaDetalhada(cartao, mesFiltro).transacoes" :key="t.id" class="compra-item-bloco mt-10">
                    <div style="display:flex; justify-content: space-between; width: 100%; align-items: center;">
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

        <h3 class="titulo-sessao mt-30 mb-15">Contas Bancárias, Débito e Outros</h3>
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
                    <button @click="removerConta(conta.id)" class="btn-fechar text-danger">✖</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="modalPagarFatura && isPremiumPlano" class="modal-overlay blur-bg">
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
              <div class="flex-header mt-20 mb-0" style="gap:15px;">
                <button type="button" @click="modalPagarFatura = false" class="btn-link text-danger" style="text-decoration:none;">Cancelar</button>
                <button type="submit" class="btn-salvar-secundario" style="flex:1;">Confirmar Pagamento</button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'fixas'" class="tela-fixas animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3.5rem; margin-bottom: 15px;">📅</div>
          <h2>Despesas Fixas Automáticas</h2>
          <p class="text-muted mb-20" style="max-width: 500px; margin: 0 auto 25px;">Esquecer de pagar uma conta de consumo gera multas. O módulo de Despesas Fixas avisa você 3 dias antes do vencimento e lança o gasto com um único clique.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <template v-else>
          <div class="cartao form-elegante mb-25">
            <h2 class="titulo-clean">Nova Despesa Recorrente</h2>
            <form @submit.prevent="adicionarDividaFixa" class="formulario">
              <div class="linha-campos">
                <div class="campo campo-largo"><label>Descrição</label><input v-model="novaDividaNome" type="text" placeholder="Ex: Internet, Luz, Condomínio..." required /></div>
                <div class="campo"><label>Valor (R$)</label><input v-model="novaDividaValor" type="number" step="0.01" placeholder="Valor Médio" required /></div>
                <div class="campo campo-pequeno"><label>Vencimento</label><input v-model="novaDividaDia" type="number" min="1" max="31" placeholder="Dia" required title="Dia Vencimento" /></div>
              </div>
              <div class="linha-campos mt-10">
                <div class="campo"><label>Categoria</label><select v-model="dividaCategoria" required><option v-for="cat in categoriasDisponiveis" :key="cat.id" :value="cat.nome">{{ cat.nome }}</option></select></div>
                <div class="campo"><label>Subcategoria</label><select v-model="dividaSubcategoria" :disabled="subcategoriasDividaDropdown.length === 0"><option v-if="subcategoriasDividaDropdown.length === 0" value="">-- Nenhuma --</option><option v-for="sub in subcategoriasDividaDropdown" :key="sub" :value="sub">{{ sub }}</option></select></div>
              </div>
              <button type="submit" class="btn-salvar-secundario mt-10" style="max-width: 250px;">Cadastrar Conta Fixa</button>
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
                    <td>{{ formatarMoeda(divida.valor) }} <button @click="editarValorDivida(divida)" class="btn-icon-soft" title="Editar Valor">✏️</button></td>
                    <td>
                      <span v-if="divida.pagamentos?.includes(mesFiltro)" class="tag-status paga">Pago neste mês</span>
                      <span v-else class="tag-status aberta">Aguardando</span>
                    </td>
                    <td>
                      <div class="acoes-tabela">
                        <button v-if="!divida.pagamentos?.includes(mesFiltro)" @click="iniciarPagamentoFixo(divida)" class="btn-salvar-secundario" style="padding: 6px 12px; font-size: 0.75rem; border-radius:50px;">PAGO!</button>
                        <button @click="removerDividaFixa(divida.id)" class="btn-fechar text-danger" title="Excluir">✖</button>
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
        <div class="cartao form-elegante mb-25">
          <h2 class="titulo-clean">Novo Objetivo</h2>
          <form @submit.prevent="adicionarMeta" class="formulario">
            <div class="linha-campos">
              <div class="campo flex-grow"><label>Nome do Sonho</label><input v-model="novaMetaNome" type="text" placeholder="Ex: Viagem de Férias, Carro Novo..." required /></div>
              <div class="campo"><label>Valor Desejado (R$)</label><input v-model="novaMetaObjetivo" type="number" step="0.01" placeholder="Objetivo Final" required /></div>
            </div>
            <button type="submit" class="btn-salvar-secundario mt-10" style="max-width: 200px;">Criar</button>
          </form>
        </div>
        <div class="grid-metas mt-20">
          <div class="cartao meta-card" :class="{'atingida': meta.valorAtual >= meta.valorObjetivo}" v-for="meta in metas" :key="meta.id">
            <div class="meta-cabecalho"><h3 class="titulo-widget mb-0">{{ meta.nome }}</h3><button @click="removerMeta(meta.id)" class="btn-fechar text-danger">✖</button></div>
            <p class="meta-valores">{{ formatarMoeda(meta.valorAtual) }} <span class="text-muted text-sm">de {{ formatarMoeda(meta.valorObjetivo) }}</span></p>
            <div class="barra-progresso-fundo mb-10"><div class="barra-progresso-preenchida" :style="{ width: Math.min((meta.valorAtual / meta.valorObjetivo) * 100, 100) + '%' }"></div></div>
            <div class="meta-acoes" style="display:flex; flex-direction:column; gap:15px; align-items:center; margin-top: 15px;">
              <span class="meta-percentual" v-if="meta.valorAtual < meta.valorObjetivo">{{ Math.round((meta.valorAtual / meta.valorObjetivo) * 100) }}% concluído</span>
              <span class="meta-percentual-atingida" v-else>🎉 Objetivo Alcançado!</span>
              <button v-if="meta.valorAtual < meta.valorObjetivo" @click="iniciarAporte(meta)" class="btn-salvar-secundario" style="border-radius:50px; width: 100%;">Guardar Dinheiro</button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'familia'" class="tela-familia animacao-entrada">
        <div v-if="!isPremiumPlano" class="cartao paywall-container text-center">
          <div style="font-size: 3.5rem; margin-bottom: 15px;">👨‍👩‍👧‍👦</div>
          <h2>Contas Compartilhadas</h2>
          <p class="text-muted mb-20" style="max-width: 500px; margin: 0 auto 25px;">Gestão financeira em casal é o segredo da riqueza. Convide outras pessoas para acessar, visualizar e lançar despesas no mesmo ambiente que você de forma sincronizada.</p>
          <button class="btn-salvar-elegante btn-cor-despesa" style="max-width: 250px;">Fazer Upgrade Agora</button>
        </div>

        <template v-else>
          <div class="cartao form-elegante">
            <h2 class="titulo-clean">Membros do seu Cofre</h2>
            <div class="tabela-responsiva mb-25 mt-20">
              <table class="tabela">
                <thead><tr><th>E-mail</th><th>Ações</th></tr></thead>
                <tbody>
                  <tr v-for="email in familiaAtual.membros" :key="email">
                    <td><strong style="font-size: 1rem;">{{ email }}</strong><span v-if="familiaAtual.admin === email" class="tag-pro ml-10" style="background:var(--primary);">👑 Admin</span></td>
                    <td><button v-if="isAdmin && email !== usuarioLogado.email" @click="removerMembro(email)" class="btn-fechar text-danger" style="font-size: 1rem;" title="Revogar Acesso">✖</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div v-if="isAdmin" style="background: var(--input-bg); padding: 30px; border-radius: 16px;">
              <h3 class="titulo-clean mb-15 text-center">Convidar Nova Pessoa</h3>
              <form @submit.prevent="convidarMembro" class="formulario" style="display:flex; flex-direction:column; align-items:center; gap: 20px;">
                <div class="campo" style="width: 100%; max-width: 400px;"><input v-model="emailConvite" type="email" placeholder="Digite o e-mail do seu parceiro(a)..." required style="background: var(--bg-app); text-align: center;"/></div>
                <button type="submit" class="btn-salvar-secundario" :disabled="statusEnvio !== ''" style="padding: 12px 30px; font-size: 1rem;">{{ statusEnvio || 'Enviar Convite Automático' }}</button>
              </form>
            </div>
          </div>
        </template>
      </section>

      <section v-if="telaAtual === 'dashboard'" class="tela-dashboard animacao-entrada">
        
        <div class="grid-atalhos mb-25">
          <button @click="abrirFormularioRapido('despesa')" class="btn-atalho despesa-btn">
            <div class="icone-atalho">📉</div><span>Despesa</span>
          </button>
          <button @click="abrirFormularioRapido('receita')" class="btn-atalho receita-btn">
            <div class="icone-atalho">📈</div><span>Receita</span>
          </button>
          <button @click="abrirFormularioRapido('transferencia')" class="btn-atalho transferencia-btn">
            <div class="icone-atalho">↔️</div><span>Transferir</span>
          </button>
          <button @click="abrirFormularioRapido('meta')" class="btn-atalho meta-btn">
            <div class="icone-atalho">🎯</div><span>Aporte</span>
          </button>
        </div>

        <div v-if="contasVencendo.length > 0" class="alerta-vencimento mb-25 animacao-entrada">
          <div class="alerta-header">⚠️ Você tem despesas fixas exigindo atenção!</div>
          <div v-for="conta in contasVencendo" :key="conta.id" class="alerta-linha">
            <span><strong>{{ conta.nome }}</strong> ({{ formatarMoeda(conta.valor) }})</span>
            <div style="display:flex; align-items:center; gap: 15px;">
              <span :class="conta.corClass"><strong>{{ conta.status }}</strong></span>
              <button @click="iniciarPagamentoFixo(conta)" class="btn-salvar-secundario" style="padding: 6px 15px; border-radius: 30px;">Pagar Agora</button>
            </div>
          </div>
        </div>

        <div class="grid-resumo mb-25">
          <div class="cartao-resumo receitas">
            <h3>Entradas do Mês</h3><p>{{ formatarMoeda(totalReceitas) }}</p>
          </div>
          <div class="cartao-resumo despesas">
            <h3>Saídas e Metas</h3><p>{{ formatarMoeda(totalDespesas + totalAportes) }}</p>
          </div>
          <div class="cartao-resumo saldo" :class="saldoAtualMes >= 0 ? 'saldo-positivo' : 'saldo-negativo'">
            <h3>Saldo Livre</h3><p>{{ formatarMoeda(saldoAtualMes) }}</p>
          </div>
        </div>

        <div class="dashboard-bento" style="gap: 25px; align-items: start;">
          <div class="cartao bento-item widget-orcamento">
            <h3 class="titulo-widget">Monitor de Orçamentos</h3>
            <div v-if="orcamentosStatus.length > 0" class="lista-metas-dash">
              <div v-for="orc in orcamentosStatus" :key="orc.nome" class="meta-item-dash mb-20">
                <div class="meta-header-dash">
                  <span class="font-weight-bold">{{ orc.nome }}</span>
                  <span class="text-sm" :style="{ color: orc.cor, fontWeight: '700' }">{{ formatarMoeda(orc.gasto) }} <span style="color:var(--text-muted); font-weight: 500;">/ {{ formatarMoeda(orc.limite) }}</span></span>
                </div>
                <div class="barra-progresso-fundo mt-10"><div class="barra-progresso-preenchida" :style="{ width: Math.min(orc.percentual, 100) + '%', backgroundColor: orc.cor }"></div></div>
              </div>
            </div>
            <div v-else class="vazio-widget">Nenhum limite definido em categorias.</div>
          </div>
          
          <div class="cartao bento-item widget-cartoes">
            <h3 class="titulo-widget">Últimas Compras (Cartão)</h3>
            <div v-if="ultimasComprasCartao.length > 0 && isPremiumPlano" class="lista-compras-dash">
              <div v-for="t in ultimasComprasCartao" :key="t.id" class="compra-item-dash mb-15 pb-15" style="border-bottom: 1px solid var(--input-bg); display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  <span class="font-weight-bold" style="font-size: 0.95rem;">{{ t.descricao }}</span>
                  <span class="text-xs text-muted">{{ formatarData(t.dataCompra || t.data) }} no {{ t.conta }}</span>
                </div>
                <strong class="texto-vermelho" style="font-size: 1.1rem;">{{ formatarMoeda(t.valor) }}</strong>
              </div>
            </div>
            <div v-else-if="!isPremiumPlano" class="vazio-widget text-muted">Gestão de Cartões requer plano PRO.</div>
            <div v-else class="vazio-widget text-muted">Nenhuma compra no cartão registrada.</div>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'lancamentos'" class="tela-lancamentos animacao-entrada">
        
        <input type="file" ref="inputComprovanteOculto" style="display: none" @change="processarAnexoPosterior" accept="image/*,application/pdf" />

        <button v-if="!mostrarFormulario" @click="alternarFormulario" class="fab-btn-central animacao-entrada" title="Novo Lançamento">+</button>

        <div v-if="mostrarFormulario" class="cartao form-elegante animacao-entrada mb-25" id="form-lancamento">
          <div class="cabecalho-form" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px;">
            <h2 class="titulo-clean mb-0">{{ dividaSendoPaga ? 'Confirmar Pagamento de Despesa Fixa' : 'Novo Lançamento' }}</h2>
            <button @click="alternarFormulario(); dividaSendoPaga = null;" class="btn-fechar text-danger" style="font-size: 1.5rem;">✖</button>
          </div>
          
          <div v-if="categoriasDisponiveis.length === 0 || contasDisponiveis.length === 0" class="alerta-categorias text-center p-20">Cadastre 1 Categoria e 1 Conta para lançar.</div>
          
          <form v-else @submit.prevent="adicionarTransacao" class="formulario" style="gap: 24px;">
            <div class="toggle-container quadruplo" v-if="!dividaSendoPaga">
              <button type="button" :class="['btn-toggle', tipo === 'despesa' ? 'ativo-despesa' : '']" @click="tipo = 'despesa'">Despesa</button>
              <button type="button" :class="['btn-toggle', tipo === 'receita' ? 'ativo-receita' : '']" @click="tipo = 'receita'">Receita</button>
              <button type="button" :class="['btn-toggle', tipo === 'transferencia' ? 'ativo-transferencia' : '']" @click="tipo = 'transferencia'">Transferência</button>
              <button type="button" :class="['btn-toggle', tipo === 'meta' ? 'ativo-meta' : '']" @click="tipo = 'meta'" :disabled="metasPendentes.length === 0">Meta</button>
            </div>
            
            <div class="linha-campos">
              <div class="campo"><label>Data da Transação</label><input v-model="dataLancamento" type="date" required /></div>
              <div class="campo campo-largo"><label>Descrição (Ex: Uber, Mercado...)</label><input v-model="descricao" type="text" required /></div>
              <div class="campo"><label>Valor (R$)</label><input v-model="valor" type="number" step="0.01" required style="font-size: 1.1rem; font-weight: bold;"/></div>
            </div>
            
            <div class="linha-campos">
              <div class="campo">
                <label>{{ tipo === 'receita' ? 'O dinheiro entrou onde?' : 'De onde o dinheiro saiu?' }}</label>
                <select v-model="contaSelecionada" required>
                  <option v-for="conta in contasDisponiveis" :key="conta.id" :value="conta.nome" :disabled="conta.tipo === 'Cartão de Crédito' && !isPremiumPlano">{{ conta.nome }} {{ conta.tipo === 'Cartão de Crédito' && !isPremiumPlano ? '🔒 PRO' : '' }}</option>
                </select>
              </div>

              <div v-if="tipo === 'transferencia'" class="campo">
                <label>Para qual conta o dinheiro foi?</label>
                <select v-model="contaDestinoSelecionada" required>
                  <option v-for="conta in contasDisponiveis" :key="conta.id" :value="conta.nome" :disabled="conta.tipo === 'Cartão de Crédito' && !isPremiumPlano">{{ conta.nome }} {{ conta.tipo === 'Cartão de Crédito' && !isPremiumPlano ? '🔒 PRO' : '' }}</option>
                </select>
              </div>
              
              <div class="campo">
                <label>Responsável pelo lançamento</label>
                <select v-model="responsavel" required><option v-for="membro in familiaAtual.membros" :key="membro" :value="membro">{{ extrairNome(membro) }}</option></select>
              </div>

              <div v-if="tipo === 'transferencia'" class="campo">
                <label>Quem recebeu o dinheiro?</label>
                <select v-model="beneficiario" required><option v-for="membro in familiaAtual.membros" :key="membro" :value="membro">{{ extrairNome(membro) }}</option></select>
              </div>
              <div v-else-if="tipo === 'meta'" class="campo">
                <label>Para qual Objetivo?</label>
                <select v-model="metaSelecionada" required><option v-for="m in metasPendentes" :key="m.id" :value="m.id">{{ m.nome }}</option></select>
              </div>
              <template v-else>
                <div class="campo"><label>Categoria Principal</label><select v-model="categoriaSelecionada" required><option v-for="cat in categoriasDisponiveis" :key="cat.id" :value="cat.nome">{{ cat.nome }}</option></select></div>
                <div class="campo"><label>Subcategoria (Opcional)</label><select v-model="subcategoriaSelecionada" :disabled="subcategoriasDropdown.length === 0"><option v-if="subcategoriasDropdown.length === 0" value="">-- Nenhuma --</option><option v-for="sub in subcategoriasDropdown" :key="sub" :value="sub">{{ sub }}</option></select></div>
              </template>
            </div>
            
            <div class="secao-parcelamento" v-if="tipo !== 'meta' && !dividaSendoPaga">
              <label class="checkbox-sutil"><input type="checkbox" v-model="isParcelado"><span class="texto-check">Essa compra foi parcelada?</span></label>
              
              <div v-if="isParcelado" class="opcoes-parcelamento animacao-entrada" style="background: var(--input-bg); padding: 20px; border-radius: 12px; margin-top: 10px;">
                <div class="linha-campos">
                  <div class="campo campo-pequeno"><label>Qtd. Parcelas</label><input v-model="numeroParcelas" type="number" min="2" max="120" /></div>
                  <div class="campo" v-if="!isContaCartaoSelecionada"><label>Vencimento 1ª Parcela</label><input v-model="dataPrimeiraParcela" type="date" required /></div>
                  <div class="campo" v-else style="justify-content: center;"><span class="text-sm font-weight-bold texto-verde">✓ Parcelas vinculadas automaticamente nas faturas seguintes.</span></div>
                </div>
              </div>
            </div>

            <div class="linha-campos" style="border-top: 1px dashed var(--borda); padding-top: 25px;">
              <div class="campo" v-if="isPremiumPlano">
                <label>Comprovante / Nota Fiscal</label>
                <input type="file" id="input-comprovante" @change="selecionarArquivo" accept="image/*,application/pdf" class="input-arquivo" />
              </div>
              <div v-else class="text-sm text-muted" style="background: rgba(0,0,0,0.02); padding: 15px; border-radius: 12px; text-align: center; width: 100%;">
                📎 O armazenamento em nuvem de recibos e notas fiscais é exclusivo do plano PRO.
              </div>
            </div>

            <button type="submit" :class="['btn-salvar-elegante', `btn-cor-${tipo}`]" :disabled="uploadProgresso" style="border-radius: 50px; padding: 18px; font-size: 1.1rem; margin-top: 10px;">
              {{ uploadProgresso ? 'Enviando para a Nuvem...' : 'Salvar Lançamento' }}
            </button>
          </form>
        </div>

        <div class="cartao mt-20">
          <div class="flex-header mb-15">
            <h3 class="titulo-clean mb-0">Tabela de Movimentações ({{ mesFormatado }})</h3>
            <div class="acoes-exportacao">
              <button v-if="isPremiumPlano" @click="exportarCSV" class="btn-export">Baixar Excel</button>
              <button v-if="isPremiumPlano" @click="exportarPDF" class="btn-export pdf-btn">Baixar PDF</button>
              <span v-else class="text-muted text-xs">Exportações 🔒 PRO</span>
            </div>
          </div>

          <div class="tabela-responsiva">
            <table class="tabela">
              <thead><tr><th>Data</th><th>Descrição / Conta</th><th>Categoria</th><th>Pessoa</th><th>Valor</th><th>Ações</th></tr></thead>
              <tbody>
                <tr v-if="transacoesVisiveisTabela.length === 0"><td colspan="6" class="centro text-muted">Ainda não há lançamentos neste mês.</td></tr>
                <tr v-for="t in transacoesVisiveisTabela" :key="t.id">
                  <td><strong style="color:var(--text-principal);">{{ formatarData(t.data) }}</strong></td>
                  <td>
                    <div class="descricao-celula">
                      <span class="desc-texto">{{ t.descricao }} <a v-if="t.comprovanteUrl && isPremiumPlano" :href="t.comprovanteUrl" target="_blank" class="link-comprovante">[Ver Anexo]</a></span>
                      <span class="tag-status" style="background:var(--input-bg); color:var(--text-muted); font-size: 0.65rem;">{{ t.tipo === 'transferencia' && t.contaDestino ? t.conta + ' ➔ ' + t.contaDestino : t.conta || '-' }}</span>
                    </div>
                  </td>
                  <td>
                    <span v-if="t.tipo === 'transferencia'" class="tag-status" style="background:var(--input-bg); border: 1px solid var(--borda);">Acerto</span>
                    <span v-else-if="t.tipo === 'meta'" class="tag-status" style="background:rgba(2, 132, 199, 0.1); color:var(--meta-cor);">🎯 {{ t.nomeMeta }}</span>
                    <span v-else class="text-sm text-muted">{{ t.categoria }} {{ t.subcategoria ? ' / ' + t.subcategoria : '' }}</span>
                  </td>
                  <td><span v-if="t.tipo === 'transferencia'" class="text-sm">{{ extrairNome(t.responsavel) }} ➔ {{ extrairNome(t.beneficiario) }}</span><span v-else class="text-sm">{{ extrairNome(t.responsavel) }}</span></td>
                  <td :class="t.tipo === 'receita' ? 'texto-verde' : t.tipo === 'despesa' ? 'texto-vermelho' : t.tipo === 'meta' ? 'texto-azul' : 'texto-roxo'" style="font-weight: 700;">
                    {{ t.tipo === 'receita' ? '+' : t.tipo === 'despesa' ? '-' : t.tipo === 'meta' ? '↓' : '↔' }} {{ formatarMoeda(t.valor) }}
                  </td>
                  <td>
                    <div class="acoes-tabela">
                      <button @click="apagarTransacao(t)" class="btn-fechar text-danger" style="font-size: 1.1rem;" title="Apagar">✖</button>
                      <button v-if="!t.comprovanteUrl && isPremiumPlano" @click="abrirSeletorArquivo(t)" class="btn-link-anexo" :disabled="uploadingId === t.id">{{ uploadingId === t.id ? '⏳' : '📎' }}</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="telaAtual === 'categorias'" class="tela-categorias animacao-entrada">
        <div class="cartao form-elegante mb-25">
          <h2 class="titulo-clean">Nova Categoria Manual</h2>
          <form @submit.prevent="adicionarCategoria" class="formulario em-linha">
            <div class="campo flex-grow"><input v-model="novaCategoria" type="text" placeholder="Ex: Casa, Carro, Lazer..." required /></div>
            <button type="submit" class="btn-salvar-secundario" style="border-radius:50px; padding: 14px 25px;">Adicionar</button>
          </form>
        </div>
        <div class="cartao mt-20" v-for="cat in categoriasDisponiveis" :key="cat.id" style="padding: 20px;">
          <div class="cabecalho-categoria" style="display: flex; justify-content: space-between; align-items: center;">
            <div class="info-cat-header">
              <h3 class="titulo-categoria mb-0" style="font-size: 1.1rem;">{{ cat.nome }}</h3>
              <span class="etiqueta-limite ml-10" :class="{'tem-limite': cat.limiteMensal > 0}">{{ cat.limiteMensal > 0 ? `Teto Mensal: ${formatarMoeda(cat.limiteMensal)}` : 'Sem Limite Definido' }}</span>
            </div>
            <div class="acoes-categoria" style="display:flex; align-items:center; gap: 15px;">
              <button v-if="isPremiumPlano" @click="definirLimite(cat)" class="btn-salvar-secundario" style="background:var(--input-bg); color:var(--primary); border-radius:30px; font-size:0.75rem; padding: 6px 15px; box-shadow:none;">Definir Limite</button>
              <button v-else class="btn-salvar-secundario" title="Requer plano PRO" style="background:var(--input-bg); color:var(--text-muted); border-radius:30px; font-size:0.75rem; padding: 6px 15px; cursor: not-allowed; box-shadow:none;">Limites 🔒</button>
              <button @click="removerCategoria(cat.id)" class="btn-fechar text-danger" style="font-size: 1.2rem;" title="Excluir Categoria">✖</button>
            </div>
          </div>
          <div class="area-subcategorias mt-15" style="background: var(--input-bg); padding: 15px; border-radius: 12px;">
            <p class="text-sm font-weight-bold mb-10">Subcategorias</p>
            <div class="etiquetas-subcategorias mb-15">
              <span v-for="sub in cat.subcategorias" :key="sub" class="tag-status" style="background: white; border: 1px solid var(--borda);">
                {{ sub }} <button @click="removerSubcategoria(cat, sub)" class="btn-fechar text-danger" style="margin-left:5px;">✖</button>
              </span>
            </div>
            <form @submit.prevent="adicionarSubcategoria(cat)" class="form-subcategoria" style="display:flex; gap:10px;">
              <input v-model="inputsSubcategoria[cat.id]" type="text" placeholder="Nova subcategoria..." style="flex:1; padding: 10px; font-size:0.85rem;" />
              <button type="submit" class="btn-salvar-secundario" style="border-radius:10px; padding: 10px 15px;">+</button>
            </form>
          </div>
        </div>
      </section>

    </main>
    
    <button @click="isPremiumPlano = !isPremiumPlano" class="fab-teste-plano" :class="isPremiumPlano ? 'fab-pro' : 'fab-free'" title="Testar Planos">
      {{ isPremiumPlano ? '👑 MODO PRO' : '🌱 MODO FREE' }}
    </button>
  </div>
</template>

<style scoped>
/* GERAIS E AUTENTICAÇÃO */
.tela-loading, .tela-login { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; background: var(--bg-app); font-family: 'Inter', sans-serif; color: var(--text-principal); }
.spinner { border: 4px solid rgba(0,0,0, 0.05); border-left-color: var(--primary); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin-bottom: 20px; }
@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

.login-card { background: var(--bg-cartao); padding: 50px 40px; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.06); text-align: center; max-width: 400px; width: 90%; border: none;}
.logo-login h2 { margin: 0 0 5px 0; font-size: 2rem; color: var(--text-principal); font-weight: 800; letter-spacing: -1px;}
.logo-login p { color: var(--text-muted); margin-bottom: 35px; font-size: 1rem; }
.text-left { text-align: left; }
.ou-divisor { display: flex; align-items: center; text-align: center; color: var(--text-muted); margin: 25px 0;}
.ou-divisor::before, .ou-divisor::after { content: ''; flex: 1; border-bottom: 1px solid var(--input-border); }
.ou-divisor span { padding: 0 15px; font-size: 0.85rem;}

.toggle-login { display: flex; background: var(--input-bg); padding: 6px; border-radius: 16px; margin-bottom: 30px;}
.toggle-login button { flex: 1; padding: 12px; border: none; background: transparent; border-radius: 12px; cursor: pointer; font-weight: 600; color: var(--text-muted); transition: 0.3s; font-size: 0.95rem;}
.toggle-login button.ativo { background: var(--bg-cartao); color: var(--text-principal); box-shadow: 0 4px 15px rgba(0,0,0,0.05); }

.btn-google { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 16px; background: var(--bg-cartao); border: 1px solid var(--input-border); border-radius: 16px; font-size: 1rem; font-weight: 600; color: var(--text-principal); cursor: pointer; transition: 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.02); }
.btn-google:hover { background: var(--input-bg); transform: translateY(-2px); box-shadow: 0 6px 12px rgba(0,0,0,0.05);}

/* NOVO: TOAST NOTIFICATION */
.toast-notificacao { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-radius: 50px; color: white; font-weight: 600; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,0.15); font-size: 0.95rem; letter-spacing: 0.3px;}
.toast-sucesso { background-color: #10b981; }
.toast-erro { background-color: #ef4444; }
.toast-icone { font-size: 1.2rem; }
.animacao-toast { animation: dropDown 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes dropDown { 0% { opacity: 0; transform: translate(-50%, -20px); } 100% { opacity: 1; transform: translate(-50%, 0); } }

/* MOTOR DE TEMAS (APP STYLE) */
.paleta-azul { --primary: #3b82f6; --primary-rgb: 59, 130, 246; --bg-light-tint: #eff6ff; }
.paleta-verde { --primary: #10b981; --primary-rgb: 16, 185, 129; --bg-light-tint: #ecfdf5; }
.paleta-laranja { --primary: #f97316; --primary-rgb: 249, 115, 22; --bg-light-tint: #fff7ed; }
.paleta-roxo { --primary: #8b5cf6; --primary-rgb: 139, 92, 246; --bg-light-tint: #f5f3ff; }
.paleta-rosa { --primary: #ec4899; --primary-rgb: 236, 72, 153; --bg-light-tint: #fdf2f8; }

.tema-claro { --bg-app: var(--bg-light-tint, #f8fafc); --bg-cartao: #ffffff; --text-principal: #0f172a; --text-muted: #64748b; --borda: #f1f5f9; --input-bg: #f8fafc; --input-border: #e2e8f0; --receita: #10b981; --despesa: #ef4444; --transferencia: #8b5cf6; --meta-cor: #0ea5e9; --laranja: #f59e0b;}
.tema-escuro { --bg-app: #0b0f19; --bg-cartao: #111827; --text-principal: #f8fafc; --text-muted: #94a3b8; --borda: #1f2937; --input-bg: #1f2937; --input-border: #374151; --receita: #10b981; --despesa: #ef4444; --transferencia: #8b5cf6; --meta-cor: #0ea5e9; --laranja: #f59e0b;}

.app-layout { display: flex; flex-direction: column; min-height: 100vh; background-color: var(--bg-app); color: var(--text-principal); font-family: 'Inter', sans-serif; transition: background-color 0.4s ease; }

/* SELETOR DE CORES NO PERFIL */
.seletor-cores { display: flex; gap: 15px; margin-top: 5px;}
.btn-cor { width: 40px; height: 40px; border-radius: 50%; border: 3px solid transparent; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 10px rgba(0,0,0,0.15);}
.btn-cor:hover { transform: scale(1.15); }
.cor-ativa { border-color: var(--text-principal); transform: scale(1.15); box-shadow: 0 0 0 4px var(--input-bg), 0 4px 15px rgba(0,0,0,0.2);}

/* APP HEADER (NAV SUPERIOR) */
.app-header { display: flex; flex-direction: column; background: var(--bg-cartao); box-shadow: 0 4px 30px rgba(0,0,0,0.03); padding: 15px 30px 0 30px; position: sticky; top: 0; z-index: 50; border-bottom-left-radius: 24px; border-bottom-right-radius: 24px; transition: 0.3s;}
.header-top { display: flex; justify-content: space-between; align-items: center; }
.logo-app { display: flex; align-items: center; gap: 12px; }
.emoji-logo { font-size: 1.8rem; background: var(--input-bg); width: 45px; height: 45px; display: flex; align-items: center; justify-content: center; border-radius: 12px;}
.logo-app h2 { margin: 0; font-size: 1.4rem; color: var(--text-principal); font-weight: 800; letter-spacing: -0.5px;}

.header-actions { display: flex; align-items: center; gap: 20px; }
.btn-icon-soft { background: var(--input-bg); border: none; color: var(--text-principal); width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; font-size: 1.2rem; outline: none;}
.btn-icon-soft:hover { background: var(--borda); transform: scale(1.05); }

.profile-chip { display: flex; align-items: center; gap: 12px; background: var(--input-bg); padding: 6px 16px 6px 6px; border-radius: 50px; cursor: pointer; transition: 0.2s; border: 1px solid var(--borda);}
.profile-chip:hover { background: var(--borda); box-shadow: 0 4px 12px rgba(0,0,0,0.05);}
.profile-chip img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
.profile-chip-info { display: flex; flex-direction: column; }
.profile-chip-info span { font-weight: 600; font-size: 0.9rem; color: var(--text-principal); line-height: 1;}
.profile-chip-info small { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.5px; margin-top: 2px;}

/* NOVO: Menu centralizado */
.header-nav { display: flex; justify-content: center; gap: 8px; overflow-x: auto; padding: 15px 0; margin-top: 15px; border-top: 1px solid var(--borda); scrollbar-width: none; }
.header-nav::-webkit-scrollbar { display: none; }
.nav-btn { padding: 12px 20px; border-radius: 30px; font-weight: 600; font-size: 0.9rem; color: var(--text-muted); background: transparent; border: none; white-space: nowrap; cursor: pointer; transition: 0.3s; display: flex; align-items: center; gap: 8px;}
.nav-btn:hover { color: var(--text-principal); background: var(--input-bg); }
.nav-btn.ativo { background: var(--primary); color: white; box-shadow: 0 4px 15px rgba(var(--primary-rgb), 0.3); }

/* TAGS E BOTÕES PRO/FREE */
.tag-pro { background: linear-gradient(135deg, #f59e0b, #d97706); color: white; font-size: 0.65rem; padding: 3px 8px; border-radius: 6px; font-weight: 700; letter-spacing: 0.5px;}
.tag-free { background: var(--input-border); color: var(--text-muted); font-size: 0.65rem; padding: 3px 8px; border-radius: 6px; font-weight: 700; letter-spacing: 0.5px;}
.paywall-container { padding: 80px 20px !important; }
.fab-teste-plano { position: fixed; bottom: 30px; left: 30px; padding: 12px 24px; border-radius: 50px; font-size: 0.85rem; font-weight: 700; color: white; border: none; cursor: pointer; z-index: 100; box-shadow: 0 8px 25px rgba(0,0,0,0.2); transition: 0.3s; letter-spacing: 0.5px;}
.fab-teste-plano:hover { transform: translateY(-4px) scale(1.05); }
.fab-pro { background: linear-gradient(135deg, #f59e0b, #d97706); }
.fab-free { background: #475569; }

/* LAYOUT CENTRALIZADO */
.conteudo-principal { max-width: 1400px; margin: 0 auto; width: 100%; padding: 40px 20px 120px; transition: 0.3s; } 
.flex-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
.titulo-pagina { margin: 0; font-size: 1.8rem; font-weight: 800; color: var(--text-principal); letter-spacing: -0.5px;}

/* NAVEGADOR DE MESES SUTIL */
.navegador-mes { display: flex; align-items: center; gap: 15px; }
.btn-seta-sutil { background: transparent; border: none; color: var(--text-muted); font-size: 1.4rem; cursor: pointer; transition: 0.2s; padding: 5px 15px; border-radius: 8px;}
.btn-seta-sutil:hover { background: var(--input-bg); color: var(--primary); transform: scale(1.1);}

/* ATALHOS APP-LIKE */
.grid-atalhos { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; }
.btn-atalho { padding: 20px; border-radius: 24px; border: none; font-weight: 600; font-size: 0.95rem; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; transition: 0.3s; box-shadow: 0 10px 30px rgba(0,0,0,0.03); background: var(--bg-cartao);}
.btn-atalho:hover { transform: translateY(-5px); box-shadow: 0 15px 35px rgba(0,0,0,0.06);}
.icone-atalho { font-size: 1.8rem; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; border-radius: 16px; margin-bottom: 5px;}
.despesa-btn .icone-atalho { background-color: rgba(239, 68, 68, 0.1); color: var(--despesa); }
.receita-btn .icone-atalho { background-color: rgba(16, 185, 129, 0.1); color: var(--receita); }
.transferencia-btn .icone-atalho { background-color: rgba(139, 92, 246, 0.1); color: var(--transferencia); }
.meta-btn .icone-atalho { background-color: rgba(2, 132, 199, 0.1); color: var(--meta-cor); }

/* FAB CENTRALIZADO (LANÇAMENTOS) */
.fab-btn-central { position: fixed; bottom: 35px; left: 50%; transform: translateX(-50%); width: 70px; height: 70px; border-radius: 50%; background: linear-gradient(135deg, var(--primary), #60a5fa); color: white; font-size: 2.2rem; font-weight: 300; border: none; box-shadow: 0 10px 25px rgba(var(--primary-rgb), 0.4); cursor: pointer; display: flex; justify-content: center; align-items: center; transition: 0.3s; z-index: 100; }
.fab-btn-central:hover { transform: translateX(-50%) translateY(-5px) scale(1.05); box-shadow: 0 15px 35px rgba(var(--primary-rgb), 0.5); }

/* CARTAO PRINCIPAL "SOFT UI" */
.cartao { background: var(--bg-cartao); padding: 35px; border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.03); border: none; }

/* DASHBOARD CARDS */
.grid-resumo { display: grid; grid-template-columns: repeat(3, 1fr); gap: 25px; }
.cartao-resumo { background: var(--bg-cartao); padding: 30px; border-radius: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.03); display: flex; flex-direction: column; justify-content: center;}
.cartao-resumo h3 { margin: 0 0 10px 0; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px;}
.cartao-resumo p { font-size: 2.2rem; font-weight: 800; margin: 0; letter-spacing: -1px;}
.receitas p { color: var(--receita); }
.despesas p { color: var(--text-principal); }
.saldo-positivo p { color: var(--primary); }
.saldo-negativo p { color: var(--despesa); }
.dashboard-bento { display: grid; grid-template-columns: repeat(2, 1fr); gap: 25px; align-items: start;}

/* DRE CSS */
.tabela-dre { min-width: 1000px; border-collapse: separate; border-spacing: 0; }
.tabela-dre th, .tabela-dre td { padding: 16px 12px; border-bottom: 1px solid var(--input-bg); font-size: 0.9rem; white-space: nowrap; }
.tabela-dre .col-fixa { position: sticky; left: 0; background: var(--bg-cartao); z-index: 10; font-weight: 600; border-right: 2px solid var(--input-bg); width: 220px; }
.tabela-dre .bg-table-header { background-color: var(--input-bg) !important; color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.5px;}
.tabela-dre .col-destaque { background-color: rgba(0,0,0,0.02); }
.linha-hover:hover td { background-color: rgba(0,0,0,0.01) !important; }
.linha-receita td { background-color: rgba(16, 185, 129, 0.04) !important; }
.linha-saldo td { padding: 20px 12px !important; border-top: 2px solid var(--borda); }

/* TAG STATUS (CARTÕES E TABELAS) */
.tag-status { padding: 6px 12px; border-radius: 8px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; display: inline-block; text-align: center;}
.tag-status.paga { background: rgba(16, 185, 129, 0.1); color: var(--receita); }
.tag-status.aberta { background: rgba(249, 115, 22, 0.1); color: var(--laranja); }
.tag-status.zerada { background: var(--input-bg); color: var(--text-muted); }

/* NOVO: BOTÕES DE FECHAR/X SUTIS E VERMELHOS */
.btn-fechar-form { background: transparent; border: none; color: var(--despesa); font-size: 1.5rem; cursor: pointer; transition: 0.2s; padding: 0; outline: none; line-height: 1; }
.btn-fechar-form:hover { transform: scale(1.1); }
.btn-fechar { background: transparent; border: none; color: var(--despesa); padding: 0; font-size: 1rem; cursor: pointer; font-weight: bold; transition: 0.2s; outline: none;}
.btn-fechar:hover { transform: scale(1.2); }
.btn-icon-soft.text-danger { color: var(--despesa); background: transparent; }
.btn-icon-soft.text-danger:hover { background: rgba(239, 68, 68, 0.1); transform: scale(1.1); }

/* INPUTS E FORMS (ESPAÇAMENTO) */
.input-arquivo { display: block; width: 100%; padding: 16px; border: 2px dashed var(--input-border); background: var(--input-bg); color: var(--text-principal); border-radius: 16px; font-size: 0.9rem; cursor: pointer; text-align: center;}
input, select { padding: 16px 20px; border-radius: 16px; font-size: 1rem; background-color: var(--input-bg); color: var(--text-principal); border: 2px solid transparent; outline: none; transition: 0.3s; font-weight: 500;}
input:focus, select:focus { border-color: var(--primary); background: transparent; box-shadow: 0 4px 15px rgba(var(--primary-rgb), 0.1);}
input:disabled, select:disabled { opacity: 0.6; cursor: not-allowed; }

.formulario { display: flex; flex-direction: column; gap: 24px; }
.linha-campos { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-end;}
.campo { display: flex; flex-direction: column; flex: 1; min-width: 200px; }
.campo-largo { flex: 2; }
.campo label { font-size: 0.8rem; font-weight: 700; margin-bottom: 8px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;}

/* BOTÕES GERAIS */
.btn-salvar-elegante { width: 100%; padding: 18px; color: white; border: none; border-radius: 50px; font-weight: 700; font-size: 1.05rem; cursor: pointer; transition: 0.3s; box-shadow: 0 4px 15px rgba(0,0,0,0.1);}
.btn-salvar-elegante:disabled { opacity: 0.7; cursor: not-allowed; box-shadow: none;}
.btn-salvar-elegante:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0,0,0,0.15);}

.btn-cor-receita { background-color: var(--receita); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);}
.btn-cor-despesa { background-color: var(--primary); box-shadow: 0 4px 15px rgba(var(--primary-rgb), 0.3);}
.btn-cor-transferencia { background-color: var(--transferencia); box-shadow: 0 4px 15px rgba(139, 92, 246, 0.3);}
.btn-cor-meta { background-color: var(--meta-cor); box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);}

.btn-salvar-secundario { padding: 14px 24px; background-color: var(--primary); color: white; border: none; border-radius: 50px; font-weight: 600; font-size: 0.95rem; cursor: pointer; transition: 0.3s; box-shadow: 0 4px 15px rgba(var(--primary-rgb), 0.3);}
.btn-salvar-secundario:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(var(--primary-rgb), 0.4); }
.btn-salvar-secundario:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; transform: none;}

.btn-link { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 0.9rem; font-weight: 600; transition: 0.2s;}
.btn-link:hover { color: var(--text-principal); }

/* TABELAS */
.cabecalho-lista-tabela { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--borda); padding-bottom: 20px; margin-bottom: 20px; }
.btn-export { padding: 10px 20px; font-size: 0.85rem; font-weight: 700; border-radius: 50px; cursor: pointer; border: 2px solid var(--primary); background: transparent; color: var(--primary); transition: 0.3s; }
.btn-export:hover { background: var(--primary); color: white; box-shadow: 0 4px 15px rgba(var(--primary-rgb), 0.2);}
.pdf-btn { border-color: var(--despesa); color: var(--despesa); }
.pdf-btn:hover { background: var(--despesa); box-shadow: 0 4px 15px rgba(239, 68, 68, 0.2);}

.tabela { width: 100%; border-collapse: collapse; }
.tabela th { text-transform: uppercase; font-size: 0.75rem; font-weight: 700; color: var(--text-muted); padding: 18px 15px; border-bottom: 2px solid var(--borda); text-align: left; letter-spacing: 0.5px;}
.tabela td { padding: 20px 15px; border-bottom: 1px solid var(--input-bg); font-size: 0.95rem; vertical-align: middle;}
.centro { text-align: center; }

/* UTILIDADES */
.ml-10 { margin-left: 10px; }
.mt-5 { margin-top: 5px; }
.mt-10 { margin-top: 10px; }
.mt-15 { margin-top: 15px; }
.mt-20 { margin-top: 20px; }
.mt-25 { margin-top: 25px; }
.mt-30 { margin-top: 30px; }
.mb-0 { margin-bottom: 0; }
.mb-10 { margin-bottom: 10px; }
.mb-15 { margin-bottom: 15px; }
.mb-20 { margin-bottom: 20px; }
.mb-25 { margin-bottom: 25px; }
.pb-10 { padding-bottom: 10px; }
.pb-15 { padding-bottom: 15px; }
.p-20 { padding: 20px; }

.titulo-clean { font-size: 1.3rem; font-weight: 800; margin: 0 0 15px 0; color: var(--text-principal); letter-spacing: -0.5px;}
.titulo-sessao { font-size: 1.6rem; font-weight: 800; color: var(--text-principal); letter-spacing: -0.5px;}
.text-muted { color: var(--text-muted); }
.text-center { text-align: center; }

.animacao-entrada { animation: fadeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
:global(body) { margin: 0; padding: 0; background-color: var(--bg-app); font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; overflow-x: hidden;}

/* MODALS E FUNDO DESFOCADO (BLUR) */
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; align-items: center; z-index: 1000; }
.blur-bg { background: rgba(0,0,0,0.4); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.modal-conteudo { width: 100%; max-width: 450px; max-height: 90vh; overflow-y: auto; box-shadow: 0 25px 50px rgba(0,0,0,0.15);}

/* AUDITORIA (TIMELINE) CSS CORRIGIDO */
.tela-auditoria .timeline { border-left: 3px solid var(--borda); padding-left: 30px; margin-left: 15px; margin-top: 20px;}
.timeline-item { position: relative; margin-bottom: 30px; }
.timeline-item::before { content: ''; position: absolute; left: -39px; top: 0; width: 14px; height: 14px; background-color: var(--primary); border-radius: 50%; border: 3px solid var(--bg-cartao); box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.2); }
.timeline-time { margin-bottom: 6px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
.timeline-content { background-color: var(--input-bg); padding: 15px 20px; border-radius: 12px; border: 1px solid var(--borda); }

/* ALERTA DASHBOARD */
.alerta-vencimento { background-color: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 16px; overflow: hidden; }
.alerta-header { background-color: rgba(239, 68, 68, 0.1); color: var(--despesa); padding: 15px 20px; font-weight: 800; font-size: 0.95rem; border-bottom: 1px solid rgba(239, 68, 68, 0.2); }
.alerta-linha { display: flex; justify-content: space-between; align-items: center; padding: 20px; border-bottom: 1px solid rgba(239, 68, 68, 0.1); color: var(--text-principal); }
.alerta-linha:last-child { border-bottom: none; }

/* CARTÕES DE CRÉDITO WIDGET */
.cartao-credito-widget { background: var(--bg-cartao); border: 1px solid var(--borda); box-shadow: 0 10px 40px rgba(0,0,0,0.06); border-radius: 24px; padding: 30px;}
.cartao-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--borda); padding-bottom: 15px; }
.valor-fatura { font-size: 2.5rem; font-weight: 800; color: var(--text-principal); letter-spacing: -1px; margin-top: 5px;}
.limite-info { display: flex; justify-content: space-between; margin-top: 5px; }
.cartao-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 20px; border-top: 1px dashed var(--borda); }
.detalhes-fatura summary { outline: none; user-select: none; }
.lista-compras { max-height: 300px; overflow-y: auto; padding-right: 10px; }
.compra-item-bloco { display: flex; flex-wrap: wrap; font-size: 0.85rem; color: var(--text-principal); }
.acoes-cartao { display: flex; gap: 10px; }

/* METAS CSS REDESENHADO */
.grid-metas { display: grid; grid-template-columns: repeat(2, 1fr); gap: 25px; }
.meta-card { display: flex; flex-direction: column; justify-content: space-between; border: 1px solid var(--borda); transition: 0.2s;}
.meta-card.atingida { background-color: rgba(16, 185, 129, 0.03); border: 1px solid rgba(16, 185, 129, 0.2); }
.meta-cabecalho { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
.meta-valores { font-size: 1.6rem; font-weight: 800; color: var(--text-principal); margin: 0 0 15px 0; letter-spacing: -0.5px;}
.barra-progresso-fundo { width: 100%; background-color: var(--input-bg); border-radius: 8px; height: 10px; overflow: hidden; }
.barra-progresso-preenchida { background-color: var(--meta-cor); height: 100%; border-radius: 8px; transition: width 0.5s ease; }
.meta-card.atingida .barra-progresso-preenchida { background-color: #10b981; }
.meta-percentual { font-size: 0.85rem; font-weight: 700; color: var(--meta-cor); }
.meta-percentual-atingida { font-size: 0.9rem; font-weight: 700; color: #10b981; }

/* Outros ajustes herdados */
.toggle-container { display: flex; background: var(--input-bg); padding: 6px; border-radius: 16px; margin-bottom: 5px; width: 100%; border: 1px solid transparent;}
.btn-toggle { flex: 1; padding: 12px 25px; border: none; background: transparent; color: var(--text-muted); font-weight: 700; border-radius: 12px; cursor: pointer; transition: 0.3s; font-size: 0.9rem;}
.ativo-despesa { background: var(--bg-cartao); color: var(--despesa) !important; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
.ativo-receita { background: var(--bg-cartao); color: var(--receita) !important; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
.ativo-transferencia { background: var(--bg-cartao); color: var(--transferencia) !important; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
.ativo-meta { background: var(--bg-cartao); color: var(--meta-cor) !important; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
.btn-toggle:disabled { opacity: 0.4; cursor: not-allowed; }

.acoes-tabela { display: flex; align-items: center; gap: 15px; }
.btn-link-apagar { background: none; border: none; color: var(--despesa); cursor: pointer; font-size: 0.85rem; font-weight: 600; transition: 0.2s;}
.btn-link-apagar:hover { transform: scale(1.05); }
.btn-link-anexo { background: rgba(37, 99, 235, 0.1); border: none; color: var(--primary); cursor: pointer; font-size: 0.8rem; font-weight: 700; padding: 6px 12px; border-radius: 50px; transition: 0.2s; display: flex; align-items: center; gap: 6px; }
.btn-link-anexo:hover:not(:disabled) { background: var(--primary); color: white;}
</style>