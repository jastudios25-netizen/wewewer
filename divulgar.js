const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    PermissionsBitField,
    ContainerBuilder,
    MessageFlags,
} = require('discord.js');
// ======================================================
// UTILITÁRIOS
// ======================================================
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ======================================================
// CACHE
// ======================================================
const serverCache = new Map(); // guildId -> {data: {name, time, divulgado, divulgou, total}, lastUpdated: timestamp}
const channelCache = new Map(); // guildId -> {channelId, lastUpdated: timestamp}
const CACHE_EXPIRATION_MS = 300000; // 5 minutes
// ======================================================
// FUNÇÃO PARA MONTAR O PAINEL
// ======================================================
async function buildPanel(guildId, guildName, supabase, errorMessage = '') {
    // Sempre consulta enable_divu e name do banco
    const { data: serverCore, error: serverError } = await supabase
        .from('servers')
        .select('name, enable_divu')
        .eq('guild_id', guildId)
        .single();
    if (serverError || !serverCore) {
        throw new Error('SERVER_NOT_FOUND');
    }

    let counters;
    const nowTime = Date.now();
    const cachedServer = serverCache.get(guildId);
    if (cachedServer && (nowTime - cachedServer.lastUpdated < CACHE_EXPIRATION_MS)) {
        counters = cachedServer.data;
    } else {
        const { data } = await supabase
            .from('servers')
            .select('time, divulgado, divulgou, total')
            .eq('guild_id', guildId)
            .single();
        counters = data;
        serverCache.set(guildId, {data: counters, lastUpdated: nowTime});
    }

    const server = { ...serverCore, ...counters };

    // Busca canal de divulgação na tabela 'id'
    let channelId;
    const cachedChannel = channelCache.get(guildId);
    if (cachedChannel && (nowTime - cachedChannel.lastUpdated < CACHE_EXPIRATION_MS)) {
        channelId = cachedChannel.channelId;
    } else {
        const { data: idRow } = await supabase
            .from('id')
            .select('id2')
            .eq('id1', guildId)
            .single();
        channelId = idRow ? idRow.id2 : null;
        channelCache.set(guildId, {channelId, lastUpdated: nowTime});
    }
    // Reset diário à meia-noite
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const serverDate = server.time ? new Date(server.time).toISOString().split('T')[0] : '1970-01-01';
    if (currentDate !== serverDate) {
        const updatedData = { divulgado: 0, divulgou: 0, time: now.toISOString() };
        await supabase
            .from('servers')
            .update(updatedData)
            .eq('guild_id', guildId);
        Object.assign(server, updatedData);
        serverCache.set(guildId, {data: { time: server.time, divulgado: server.divulgado, divulgou: server.divulgou, total: server.total }, lastUpdated: nowTime});
    }
    const channelMention = channelId ? `<#${channelId}>` : 'Não configurado';
    const status = server.enable_divu ? '🟢 Ligado' : '🔴 Desligado';
    const container = new ContainerBuilder()
        .setAccentColor(0x1f1f1f);
    if (errorMessage) {
        container.addTextDisplayComponents((textDisplay) =>
            textDisplay.setContent(errorMessage)
        );
        container.addSeparatorComponents((separator) => separator);
    }
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(`📢 **Painel de Divulgação - ${server.name || guildName}**`)
    );
    container.addSeparatorComponents((separator) => separator);
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(`Canal de Divulgação: ${channelMention}\nStatus do Divulgador: ${status}`)
    );
    container.addSeparatorComponents((separator) => separator);
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(` Divulgou\n\`${server.divulgou || 0}\` servidores`)
    );
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(` Foi Divulgado\n\`${server.divulgado || 0}\` vezes`)
    );
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(` Total\n\`${server.total || 0}\``)
    );
    const toggleLabel = server.enable_divu ? 'Desligar Divulgador' : 'Ligar Divulgador';
    const toggleStyle = server.enable_divu ? ButtonStyle.Danger : ButtonStyle.Success;
    container.addActionRowComponents((actionRow) =>
        actionRow.setComponents(
            new ButtonBuilder()
                .setCustomId(`toggle_divu_${guildId}`)
                .setLabel(toggleLabel)
                .setStyle(toggleStyle)
                .setEmoji('🔄'),
            new ButtonBuilder()
                .setCustomId(`update_info_${guildId}`)
                .setLabel('Atualizar')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔄'),
            new ButtonBuilder()
                .setCustomId(`config_divu_${guildId}`)
                .setLabel('Configurar Canal')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⚙️')
        )
    );
    return { container, channelId };
}
// ======================================================
// COMANDO /divulgar
// ======================================================
const handleDivulgar = async (interaction, supabase) => {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.editReply('🚫 **Apenas Administradores podem usar este comando.**');
    }
    const guildId = interaction.guild.id;
    try {
        const { container } = await buildPanel(guildId, interaction.guild.name, supabase);
        await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        if (err.message === 'SERVER_NOT_FOUND') {
            return interaction.editReply('❌ **Servidor não encontrado na base de dados.**\nCadastre seu servidor primeiro em https://cordyx.online');
        }
        console.error(err);
        return interaction.editReply('❌ Erro interno ao carregar o painel.');
    }
};
// ======================================================
// BOTÕES DO PAINEL
// ======================================================
const handleToggleDivu = async (i, s) => {
    await i.deferUpdate();
    const guildId = i.customId.split('_')[2];
    if (guildId !== i.guild.id) return;
    // Consulta enable_divu fresco
    const { data: current } = await s.from('servers').select('enable_divu').eq('guild_id', guildId).single();
    if (!current) return i.editReply({ content: '❌ Servidor não encontrado.', ephemeral: true });
    const newEnable = !current.enable_divu;
    let updates = { enable_divu: newEnable };
    if (newEnable) {
        // Zera contadores diários ao ligar
        updates.divulgado = 0;
        updates.divulgou = 0;
        updates.time = new Date().toISOString();
        // Check if channel is defined
        let channelId;
        const nowTime = Date.now();
        const cachedChannel = channelCache.get(guildId);
        if (cachedChannel && (nowTime - cachedChannel.lastUpdated < CACHE_EXPIRATION_MS)) {
            channelId = cachedChannel.channelId;
        } else {
            const { data: idRow } = await s
                .from('id')
                .select('id2')
                .eq('id1', guildId)
                .single();
            channelId = idRow ? idRow.id2 : null;
            channelCache.set(guildId, {channelId, lastUpdated: nowTime});
        }
        if (!channelId) {
            const { container } = await buildPanel(guildId, i.guild.name, s, '❌ **Configure um canal de divulgação antes de ligar o divulgador.**');
            await i.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
            return;
        }
    }
    await s.from('servers').update(updates).eq('guild_id', guildId);
    // Invalida cache dos contadores ao zerar
    if (newEnable) {
        serverCache.delete(guildId);
    }
    const { container } = await buildPanel(guildId, i.guild.name, s);
    await i.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
};
const handleUpdateInfo = async (i, s) => {
    await i.deferUpdate();
    const guildId = i.customId.split('_')[2];
    if (guildId !== i.guild.id) return;
    try {
        // Para atualizar, limpa o cache para forçar nova consulta
        serverCache.delete(guildId);
        channelCache.delete(guildId);
        const { container } = await buildPanel(guildId, i.guild.name, s);
        await i.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (err) {
        await i.editReply({ content: '❌ Servidor não encontrado.', ephemeral: true });
    }
};
const handleConfigDivu = async (i, s) => {
    await i.deferUpdate();
    const guildId = i.customId.split('_')[2];
    if (guildId !== i.guild.id) return;
    const configContainer = new ContainerBuilder()
        .setAccentColor(0x1f1f1f);
    configContainer.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent('⚙️ **Configurar Canal de Divulgação**')
    );
    configContainer.addSeparatorComponents((separator) => separator);
    configContainer.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent('Selecione o canal onde as divulgações **serão enviadas**.')
    );
    configContainer.addSeparatorComponents((separator) => separator);
    configContainer.addActionRowComponents((actionRow) =>
        actionRow.setComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`select_div_channel_${guildId}`)
                .setPlaceholder('Escolha o canal...')
                .setChannelTypes([ChannelType.GuildText])
                .setMaxValues(1)
        )
    );
    await i.editReply({ components: [configContainer], flags: MessageFlags.IsComponentsV2 });
};
const handleSelectDivChannel = async (i, s) => {
    await i.deferUpdate();
    const guildId = i.customId.split('_')[3];
    if (guildId !== i.guild.id) return;
    const channelId = i.values[0];
    const { error } = await s.from('id').upsert({
        id1: guildId,
        id2: channelId
    }, { onConflict: 'id1' });
    if (error) {
        console.error('Erro ao salvar canal:', error);
        return i.editReply({ content: '❌ Erro ao salvar o canal.', ephemeral: true });
    }
    const nowTime = Date.now();
    channelCache.set(guildId, {channelId, lastUpdated: nowTime});
    const { container } = await buildPanel(guildId, i.guild.name, s);
    await i.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
};
// ======================================================
// LOOP DE DIVULGAÇÃO (corrigido para usar tabela 'id')
// ======================================================
const startDivulgarLoop = (client, supabase) => {
    setInterval(async () => {
        try {
            // 1. Todos os canais configurados (tabela 'id')
            const { data: allDestinations } = await supabase.from('id').select('*');
            // 2. Servidores com divulgador LIGADO e dados necessários
            const { data: allActiveServers } = await supabase
                .from('servers')
                .select('guild_id, plan_type, temp, name, short_description, logo, banner, category, tags, invite, time, divulgado, total, divulgou, status, link_valid')
                .eq('enable_divu', true);
            if (!allActiveServers || allActiveServers.length === 0) return;
            const activeGuildIds = new Set(allActiveServers.map(s => s.guild_id));
            // Filtra apenas destinos de servidores com divulgador ligado
            const destinations = allDestinations.filter(row => activeGuildIds.has(row.id1));
            // 3. Conteúdo para divulgar (filtrado em memória)
            const contents = allActiveServers.filter(s => s.status === 'approved' && s.link_valid);
            if (!destinations || !contents || destinations.length < 2 || contents.length < 2) return;
            const guildToServer = new Map(allActiveServers.map(s => [s.guild_id, {...s}])); // Cópia para modificações
            const shuffledContents = shuffleArray(contents);
            const now = new Date();
            const currentDate = now.toISOString().split('T')[0];
            const updatedGuilds = new Set();
            for (const serverData of shuffledContents) {
                const plan = (serverData.plan_type || 'free').toLowerCase();
                const interval = (plan.includes('pro') || plan.includes('vip')) ? 180000 : 390000;
                let lastTime = serverData.temp ? new Date(serverData.temp).getTime() : 0;
                if (isNaN(lastTime)) lastTime = 0;
                if (now.getTime() - lastTime < interval) continue;
                const validDestinations = destinations.filter(row => row.id1 !== serverData.guild_id);
                if (validDestinations.length === 0) continue;
                const batchSize = Math.max(1, Math.floor(validDestinations.length / 5));
                const shuffledTargets = shuffleArray(validDestinations);
                const selectedTargets = shuffledTargets.slice(0, batchSize);
                // Monta embed
                const embed = new EmbedBuilder()
                    .setColor('#2B2D31')
                    .setTitle(`📢 ${serverData.name}`)
                    .setDescription(`> ${serverData.short_description || 'Venha conhecer este servidor incrível!'}`)
                    .setThumbnail(serverData.logo)
                    .setImage(serverData.banner)
                    .addFields(
                        { name: '📂 Categoria', value: `\`${serverData.category || 'Geral'}\``, inline: true },
                        { name: '🏷️ Tags', value: `\`${serverData.tags || 'Comunidade'}\``, inline: true }
                    )
                    .setFooter({ text: 'Divulgação Automática • Cordyx', iconURL: client.user.displayAvatarURL() });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Entrar no servidor')
                        .setStyle(ButtonStyle.Link)
                        .setURL(serverData.invite),
                    new ButtonBuilder()
                        .setLabel('Página do servidor')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://cordyx.online/#/server/${serverData.guild_id}`),
                    new ButtonBuilder()
                        .setLabel('Divulgue seu servidor')
                        .setStyle(ButtonStyle.Link)
                        .setURL('https://cordyx.online')
                );
                let sentCount = 0;
                for (const target of selectedTargets) {
                    try {
                        const channel = await client.channels.fetch(target.id2).catch(() => null);
                        if (!channel) continue;
                        if (channel.permissionsFor(client.user)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) {
                            await channel.send({ embeds: [embed], components: [row] });
                            sentCount++;
                            // Atualiza "foi divulgado" do servidor que RECEBEU (em memória)
                            const receiver = guildToServer.get(target.id1);
                            if (receiver) {
                                const receiverDate = receiver.time ? new Date(receiver.time).toISOString().split('T')[0] : '1970-01-01';
                                const newDivulgado = (currentDate !== receiverDate) ? 1 : (receiver.divulgado || 0) + 1;
                                const newTotal = (receiver.total || 0) + 1;
                                receiver.divulgado = newDivulgado;
                                receiver.total = newTotal;
                                receiver.time = now.toISOString();
                                updatedGuilds.add(target.id1);
                            }
                            await sleep(1000);
                        }
                    } catch (err) {}
                }
                if (sentCount > 0) {
                    // Atualiza "divulgou" do servidor que ENVIOU (em memória)
                    const sender = guildToServer.get(serverData.guild_id);
                    if (sender) {
                        const senderDate = sender.time ? new Date(sender.time).toISOString().split('T')[0] : '1970-01-01';
                        let newDivulgou = (sender.divulgou || 0) + sentCount;
                        if (currentDate !== senderDate) {
                            newDivulgou = sentCount;
                            sender.time = now.toISOString();
                        }
                        sender.divulgou = newDivulgou;
                        sender.temp = now.toISOString();
                        updatedGuilds.add(serverData.guild_id);
                    }
                }
                await sleep(2000);
            }
            // Batch update no banco
            const updatePromises = Array.from(updatedGuilds).map(guildId => {
                const serv = guildToServer.get(guildId);
                return supabase
                    .from('servers')
                    .update({
                        divulgado: serv.divulgado,
                        total: serv.total,
                        time: serv.time,
                        divulgou: serv.divulgou,
                        temp: serv.temp
                    })
                    .eq('guild_id', guildId);
            });
            await Promise.all(updatePromises);
            // Atualiza cache com novos valores
            const nowTime = Date.now();
            updatedGuilds.forEach(guildId => {
                const serv = guildToServer.get(guildId);
                serverCache.set(guildId, {
                    data: {
                        name: serv.name,
                        time: serv.time,
                        divulgado: serv.divulgado,
                        divulgou: serv.divulgou,
                        total: serv.total
                    },
                    lastUpdated: nowTime
                });
            });
        } catch (e) {
            console.error('Loop Error:', e);
        }
    }, 60000);
};
// ======================================================
// COMPATIBILIDADE (mantidos)
// ======================================================
const handleMetricsButton = async (i) => i.editReply({ content: 'Use **/divulgar** para ver o painel.', ephemeral: true });
const handleConfigMenuButton = async (i) => i.reply({ content: 'Use **/divulgar**.', ephemeral: true });
const handleSetDivChannelBtn = async (i) => i.deferUpdate();
const handleSetLogChannelBtn = async (i) => i.deferUpdate();
const handleSaveDivChannel = async (i) => i.deferUpdate();
const handleSaveLogChannel = async (i) => i.deferUpdate();
const handleToggleButton = async (i) => i.reply({ content: 'Use o botão no painel de /divulgar.', ephemeral: true });
const handleDivBack = async (i) => i.deferUpdate();
const handleSelectServerDivulgar = async (i) => i.deferUpdate();
// ======================================================
// EXPORTAÇÃO
// ======================================================
module.exports = {
    handleDivulgar,
    handleToggleDivu,
    handleUpdateInfo,
    handleConfigDivu,
    handleSelectDivChannel,
    handleMetricsButton,
    handleConfigMenuButton,
    handleSetDivChannelBtn,
    handleSetLogChannelBtn,
    handleSaveDivChannel,
    handleSaveLogChannel,
    handleToggleButton,
    handleDivBack,
    handleSelectServerDivulgar,
    startDivulgarLoop,
};