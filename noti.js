// noti.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const ADMIN_DISCORD_ID = '1027205251700363385'; // dono do site (não mexa)

// Função auxiliar para pegar o discord_user_id do dono do servidor
async function getOwnerDiscordId(supabase, user_id) {
    const { data } = await supabase
        .from('profiles')
        .select('discord_user_id')
        .eq('id', user_id)
        .single();
    return data?.discord_user_id || null;
}

// Loop principal (roda a cada 5 minutos)
async function startNotiLoop(client, supabase) {
    console.log('📢 Sistema de notificações de servidores iniciado.');

    setInterval(async () => {
        try {
            await checkPendingServers(client, supabase);
        } catch (e) {
            console.error('Erro no loop de notificações:', e);
        }
    }, 5 * 60 * 1000); // 5 minutos
}

async function checkPendingServers(client, supabase) {
    const { data: pendings, error } = await supabase
        .from('servers')
        .select('id, name, user_id, tags, category, short_description')
        .eq('status', 'pending');

    if (error || !pendings || pendings.length === 0) return;

    for (const server of pendings) {
        // Verifica se já notificamos esse servidor (reutilizamos a tabela notified_bumps, mas só para pending uma vez)
        const { data: alreadyNotified } = await supabase
            .from('notified_bumps')
            .select('id')
            .eq('server_id', server.id)
            .limit(1);

        // Só envia se NÃO foi notificado ainda (evita envios duplicados)
        if (alreadyNotified && alreadyNotified.length > 0) continue;

        // 2. Mensagem pro dono do site (admin) com botões - só uma vez
        const adminUser = await client.users.fetch(ADMIN_DISCORD_ID).catch(() => null);
        if (adminUser) {
            const embed = new EmbedBuilder()
                .setTitle('🆕 Novo servidor esperando aprovação')
                .setColor('Yellow')
                .addFields(
                    { name: 'Nome', value: server.name },
                    { name: 'Tags', value: server.tags ? (Array.isArray(server.tags) ? server.tags.join(', ') : server.tags) : 'Nenhuma' },
                    { name: 'Categoria', value: server.category || 'Nenhuma' },
                    { name: 'Descrição curta', value: server.short_description || 'Nenhuma' },
                    { name: 'ID', value: server.id.toString() }
                )
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_server_${server.id}`)
                    .setLabel('✅ Aprovar')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_server_${server.id}`)
                    .setLabel('❌ Rejeitar')
                    .setStyle(ButtonStyle.Danger)
            );

            await adminUser.send({ embeds: [embed], components: [row] }).catch(() => { /* Erro no envio pro admin */ });
        }

        // Marca como notificado APENAS se chegou até aqui (envios tentados)
        await supabase
            .from('notified_bumps')
            .insert([{ server_id: server.id, notified_at: new Date().toISOString() }]);
    }
}

// Handler dos botões de aprovação/rejeição
async function handleApproval(interaction, supabase, client) {
    if (interaction.user.id !== ADMIN_DISCORD_ID) {
        return interaction.reply({ content: '🚫 Sem permissão.', ephemeral: true });
    }

    await interaction.deferUpdate();

    const isApprove = interaction.customId.startsWith('approve_server_');
    const serverId = interaction.customId.split('_')[2];

    // Busca o servidor
    const { data: server, error } = await supabase
        .from('servers')
        .select('name, user_id')
        .eq('id', serverId)
        .single();

    if (error || !server) {
        return interaction.editReply({ content: '❌ Servidor não encontrado.' });
    }

    const newStatus = isApprove ? 'approved' : 'rejected';

    await supabase
        .from('servers')
        .update({ status: newStatus })
        .eq('id', serverId);

    // Notifica o dono do servidor (apenas no approve/reject)
    const ownerDiscordId = await getOwnerDiscordId(supabase, server.user_id);
    if (ownerDiscordId) {
        const ownerUser = await client.users.fetch(ownerDiscordId).catch(() => null);
        if (ownerUser) {
            let content = '';
            let components = [];

            if (isApprove) {
                content = `✅ **${server.name}** foi aprovado! 🎉`;
                const link = `https://cordyx.online/#/server/${serverId}`;
                components = [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('Ver servidor no site')
                            .setURL(link)
                            .setStyle(ButtonStyle.Link)
                    )
                ];
            } else {
                content = `❌ **${server.name}** foi recusado.`;
            }

            await ownerUser.send({ content, components }).catch(() => { /* DM fechada */ });
        }
    }

    // Desabilita os botões na mensagem do admin
    const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`approve_server_${serverId}`)
            .setLabel('✅ Aprovar')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`reject_server_${serverId}`)
            .setLabel('❌ Rejeitar')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(true)
    );

    await interaction.editReply({ components: [disabledRow] });
}

module.exports = { startNotiLoop, handleApproval };