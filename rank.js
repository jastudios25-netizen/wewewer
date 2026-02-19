const fs = require('fs');
const { ContainerBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

async function getRankContainer(supabase, client) {

    const { data: topViews } = await supabase
        .from('servers')
        .select('name, views')
        .eq('status', 'approved')
        .order('views', { ascending: false })
        .limit(5);

 
    const { data: topClicks } = await supabase
        .from('servers')
        .select('name, clicks')
        .eq('status', 'approved')
        .order('clicks', { ascending: false })
        .limit(5);

  
    const { data: servers } = await supabase
        .from('servers')
        .select('name, invite')
        .eq('status', 'approved')
        .eq('link_valid', true);

    const largestPromises = servers.map(async (s) => {
        try {
            const invite = await client.fetchInvite(s.invite);
            const guildId = invite.guild.id;
            const guild = client.guilds.cache.get(guildId);
            const members = guild ? guild.memberCount : invite.approximateMemberCount || 0;
            return { name: s.name, members };
        } catch {
            return { name: s.name, members: 0 };
        }
    });
    const largestResults = await Promise.all(largestPromises);
    const topLargest = largestResults.sort((a, b) => b.members - a.members).slice(0, 5);

  
    const container = new ContainerBuilder()
        .setAccentColor(0x808080); // Cinza


    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent('🏆 **Rank Top 5**')
    );


    container.addSeparatorComponents((separator) => separator);

 
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(
            topViews && topViews.length > 0
                ? `📊 **Top 5 por Views**\n${topViews.map((s, i) => `${i + 1}. **${s.name}** - ${s.views || 0} views`).join('\n')}`
                : '📊 **Top 5 por Views**\nNenhum dado disponível.'
        )
    );

    
    container.addSeparatorComponents((separator) => separator);

   
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(
            topClicks && topClicks.length > 0
                ? `🖱️ **Top 5 por Clicks**\n${topClicks.map((s, i) => `${i + 1}. **${s.name}** - ${s.clicks || 0} clicks`).join('\n')}`
                : '🖱️ **Top 5 por Clicks**\nNenhum dado disponível.'
        )
    );


    container.addSeparatorComponents((separator) => separator);

  
    container.addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(
            topLargest && topLargest.length > 0
                ? `👥 **Top 5 Maiores Servidores**\n${topLargest.map((s, i) => `${i + 1}. **${s.name}** - ${s.members} membros`).join('\n')}`
                : '👥 **Top 5 Maiores Servidores**\nNenhum dado disponível.'
        )
    );


    container.addSeparatorComponents((separator) => separator);


    container.addActionRowComponents((actionRow) =>
        actionRow.setComponents(
            new ButtonBuilder()
                .setCustomId('update_rank')
                .setLabel('Atualizar Lista')
                .setStyle(ButtonStyle.Secondary) 
        )
    );

    return container;
}

async function handleRankMessage(message, supabase, client) {
    if (message.author.id !== '1027205251700363385') return;

    const container = await getRankContainer(supabase, client);

    const sent = await message.channel.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
    });

 
    fs.writeFileSync('rank.json', JSON.stringify({
        channelId: message.channel.id,
        messageId: sent.id
    }));
}

function initRank(client, supabase) {
    setInterval(async () => {
        if (!fs.existsSync('rank.json')) return;
        const data = JSON.parse(fs.readFileSync('rank.json'));
        const channel = client.channels.cache.get(data.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(data.messageId).catch(() => null);
        if (!msg) return;
        const newContainer = await getRankContainer(supabase, client);
        await msg.edit({ components: [newContainer] });
    }, 10 * 60 * 1000); 
}

async function handleUpdate(interaction, supabase, client) {
    await interaction.deferUpdate();
    const newContainer = await getRankContainer(supabase, client);
    await interaction.editReply({ components: [newContainer] });
}

module.exports = { handleRankMessage, initRank, handleUpdate };